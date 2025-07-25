// =============================================================================
// server.js - TechMart API 
// =============================================================================

const express = require('express');
const sql = require('mssql');
const redis = require('redis');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

const app = express();

// Sécurité de base
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Trop de requêtes, réessayez plus tard.'
});
app.use('/api/', limiter);

// Variables globales
let sqlConfig = null;
let redisClient = null;

// Configuration Key Vault
const keyVaultName = process.env.KEY_VAULT_NAME || 'fokkvdev5d3e97ea';
const keyVaultUrl = `https://${keyVaultName}.vault.azure.net`;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);


function parseSQLConnectionString(connectionString) {
  const config = {
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 30000,
      requestTimeout: 30000
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

  const parts = connectionString.split(';');
  
  for (const part of parts) {
    if (!part.trim()) continue;
    
    const [key, ...valueParts] = part.split('=');
    const value = valueParts.join('=');
    
    if (!key || !value) continue;
    
    switch (key.trim()) {
      case 'Server':
        const serverPart = value.replace('tcp:', '');
        const [server, port] = serverPart.split(',');
        config.server = server;
        if (port) config.port = parseInt(port);
        break;
      case 'Initial Catalog':
        config.database = value.trim();
        break;
      case 'User ID':
        config.user = value.trim();
        break;
      case 'Password':
        config.password = value.trim();
        break;
    }
  }
  
  return config;
}

function parseRedisConnectionString(connectionString) {
  const parts = connectionString.split(',');
  const [host, port] = parts[0].split(':');
  
  let password = '';
  for (const part of parts) {
    if (part.startsWith('password=')) {
      password = part.substring('password='.length);
      break;
    }
  }
  
  return {
    socket: {
      host: host.trim(),
      port: parseInt(port) || 6380,
      tls: true,
      connectTimeout: 10000
    },
    password: password,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
  };
}

// =============================================================================
// CONNEXION AUX SERVICES AZURE
// =============================================================================

async function loadAzureSecrets() {
  try {
    console.log('🔐 Chargement des secrets Azure...');
    console.log(`🆔 AZURE_CLIENT_ID: ${process.env.AZURE_CLIENT_ID}`);
    console.log(`🔑 Key Vault URL: ${keyVaultUrl}`);
    
    // Test de connexion d'abord
    console.log('🧪 Test de connexion à Key Vault...');
    
    // Récupérer les secrets
    const sqlSecret = await secretClient.getSecret("sql-connection-string");
    const redisSecret = await secretClient.getSecret("redis-connection-string");
    
    console.log('✅ Secrets récupérés avec succès!');
    
    // Configuration SQL
    sqlConfig = parseSQLConnectionString(sqlSecret.value);
    console.log(`✅ SQL configuré: ${sqlConfig.server}/${sqlConfig.database}`);
    
    // Configuration Redis
    const redisConfig = parseRedisConnectionString(redisSecret.value);
    console.log(`✅ Redis configuré: ${redisConfig.socket.host}:${redisConfig.socket.port}`);
    
    // Connexion Redis
    redisClient = redis.createClient(redisConfig);
    redisClient.on('error', (err) => {
      console.error('Redis Error:', err.message);
    });
    redisClient.on('ready', () => {
      console.log('✅ Redis connecté et prêt');
    });
    
    await redisClient.connect();
    
    console.log('✅ Toutes les connexions Azure établies');
    return true;
    
  } catch (error) {
    console.error('❌ Erreur connexion Azure:', error.message);
    return false;
  }
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    message: '🎉 Welcome to TechMart Payment API !',
    service: 'TechMart Payment API',
    version: '1.0.0',
    status: 'Running on Azure App Service',
    endpoints: {
      health: '/health',
      info: '/api/info',
      payments: '/api/payments',
      stats: '/api/stats'
    },
    documentation: 'API pour les paiements TechMart'
  });
});

// Health Check
app.get('/health', async (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
    services: {}
  };

  try {
    // Test SQL
    if (sqlConfig) {
      const pool = await sql.connect(sqlConfig);
      await pool.request().query('SELECT 1 as test');
      health.services.database = 'Connected';
    } else {
      health.services.database = 'Not configured';
    }

    // Test Redis
    if (redisClient?.isOpen) {
      await redisClient.ping();
      health.services.cache = 'Connected';
    } else {
      health.services.cache = 'Not connected';
    }

    health.services.keyVault = 'Connected';
    res.json(health);
    
  } catch (error) {
    health.status = 'ERROR';
    health.error = error.message;
    health.services = {
      database: 'Error',
      cache: 'Error',
      keyVault: 'Unknown'
    };
    res.status(503).json(health);
  }
});

// Info API
app.get('/api/info', (req, res) => {
  res.json({
    service: 'TechMart Payment API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Créer un paiement
app.post('/api/payments', async (req, res) => {
  const startTime = Date.now();
  const { amount, currency, merchantId } = req.body;

  // Validation
  if (!amount || !currency || !merchantId) {
    return res.status(400).json({
      error: 'Paramètres requis: amount, currency, merchantId',
      timestamp: new Date().toISOString()
    });
  }

  try {
    console.log(`💳 Nouveau paiement: ${amount} ${currency} pour ${merchantId}`);

    // Cache Redis - vérifier merchant
    let merchantValid = true;
    if (redisClient?.isOpen) {
      try {
        const cacheKey = `merchant:${merchantId}`;
        const cached = await redisClient.get(cacheKey);
        
        if (!cached) {
          // Simuler validation et mettre en cache
          await redisClient.setEx(cacheKey, 300, JSON.stringify({
            valid: true,
            checkedAt: new Date().toISOString(),
            checkCount: 1
          }));
          console.log(`📝 Merchant ${merchantId} validé et mis en cache`);
        } else {
          const merchantData = JSON.parse(cached);
          merchantValid = merchantData.valid;
          console.log(`📱 Cache hit pour merchant ${merchantId}`);
        }
      } catch (redisError) {
        console.warn('⚠️ Cache Redis indisponible:', redisError.message);
        // Continuer sans cache
      }
    }

    if (!merchantValid) {
      return res.status(400).json({
        error: 'Merchant invalide',
        merchantId,
        timestamp: new Date().toISOString()
      });
    }

    // Enregistrer en base SQL
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request()
      .input('amount', sql.Decimal(10, 2), amount)
      .input('currency', sql.NVarChar, currency)
      .input('merchantId', sql.NVarChar, merchantId)
      .query(`
        INSERT INTO Payments (Amount, Currency, MerchantId, Status, CreatedAt)
        VALUES (@amount, @currency, @merchantId, 'COMPLETED', GETDATE());
        SELECT SCOPE_IDENTITY() as PaymentId;
      `);

    const paymentId = result.recordset[0].PaymentId;
    const duration = Date.now() - startTime;
    
    console.log(`✅ Paiement créé: ID=${paymentId}, durée=${duration}ms`);

    res.status(201).json({
      paymentId,
      status: 'COMPLETED',
      amount,
      currency,
      merchantId,
      processedAt: new Date().toISOString(),
      processingTime: `${duration}ms`
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Erreur paiement:', error.message);
    
    res.status(500).json({
      error: 'Erreur traitement paiement',
      message: error.message,
      timestamp: new Date().toISOString(),
      processingTime: `${duration}ms`
    });
  }
});

// Lister les paiements
app.get('/api/payments', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT TOP 20 
        PaymentId, Amount, Currency, MerchantId, Status, CreatedAt
      FROM Payments 
      ORDER BY CreatedAt DESC
    `);

    res.json({
      payments: result.recordset,
      count: result.recordset.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur liste paiements:', error.message);
    res.status(500).json({
      error: 'Erreur récupération paiements',
      timestamp: new Date().toISOString()
    });
  }
});

// Statistiques
app.get('/api/stats', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT 
        COUNT(*) as totalPayments,
        SUM(Amount) as totalAmount,
        AVG(Amount) as averageAmount,
        COUNT(DISTINCT MerchantId) as uniqueMerchants
      FROM Payments 
      WHERE CreatedAt >= DATEADD(day, -1, GETDATE())
    `);

    res.json({
      period: 'Last 24 hours',
      stats: result.recordset[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Erreur statistiques',
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// INITIALISATION
// =============================================================================

async function createTablesIfNeeded() {
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Payments' AND xtype='U')
      BEGIN
        CREATE TABLE Payments (
          PaymentId int IDENTITY(1,1) PRIMARY KEY,
          Amount decimal(10,2) NOT NULL,
          Currency nvarchar(3) NOT NULL,
          MerchantId nvarchar(50) NOT NULL,
          Status nvarchar(20) NOT NULL,
          CreatedAt datetime2 NOT NULL DEFAULT GETDATE()
        );
        
        CREATE INDEX IX_Payments_MerchantId ON Payments(MerchantId);
        CREATE INDEX IX_Payments_CreatedAt ON Payments(CreatedAt);
        
        PRINT 'Table Payments créée avec succès';
      END
      ELSE
      BEGIN
        PRINT 'Table Payments existe déjà';
      END
    `);
    console.log('✅ Base de données initialisée');
  } catch (error) {
    console.error('❌ Erreur initialisation base:', error.message);
  }
}

async function startServer() {
  console.log('🚀 Démarrage TechMart Payment API...');
  console.log(`📊 Environnement: ${process.env.NODE_ENV || 'development'}`);
  
  // Charger les connexions Azure
  const connected = await loadAzureSecrets();
  if (!connected) {
    console.error('❌ Impossible de se connecter à Azure - Arrêt');
    process.exit(1);
  }
  
  // Créer les tables
  await createTablesIfNeeded();
  
  // Démarrer le serveur
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎉 TechMart Payment API démarré sur le port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`💳 API Payments: http://localhost:${PORT}/api/payments`);
    console.log(`📈 Statistiques: http://localhost:${PORT}/api/stats`);
    console.log('✅ Serveur prêt à recevoir des requêtes !');
  });
}

// Arrêt propre
process.on('SIGTERM', async () => {
  console.log('🛑 Arrêt gracieux en cours...');
  try {
    if (redisClient) await redisClient.quit();
    if (sql.globalConnection) await sql.close();
    console.log('✅ Connexions fermées proprement');
  } catch (error) {
    console.error('⚠️ Erreur lors de l\'arrêt:', error.message);
  }
  process.exit(0);
});

// Démarrer l'application
startServer().catch(error => {
  console.error('❌ Erreur critique au démarrage:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
});