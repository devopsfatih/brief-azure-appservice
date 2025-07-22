# TechMart Payment API

API de paiement sécurisée intégrée avec Azure Services.

## Fonctionnalités

- ✅ Traitement des paiements
- ✅ Cache Redis pour performances
- ✅ Base de données SQL Azure
- ✅ Gestion des secrets via Key Vault
- ✅ Health checks complets
- ✅ Rate limiting
- ✅ Sécurité renforcée

## Endpoints

- `GET /health` - Health check
- `GET /api/info` - Informations API
- `POST /api/payments` - Créer un paiement
- `GET /api/payments` - Lister les paiements

## Variables d'Environnement

- `KEY_VAULT_NAME` - Nom du Key Vault Azure
- `NODE_ENV` - Environnement (production/development)
- `PORT` - Port d'écoute (défaut: 3000)

## Utilisation Locale

```bash
npm install
npm start
```

## Docker

```bash
docker build -t techmart-api .
docker run -p 3000:3000 techmart-api
```

## Azure Deployment

L'API utilise Managed Identity pour accéder aux services Azure :
- Azure SQL Database
- Azure Redis Cache  
- Azure Key Vault