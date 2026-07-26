# Shopee Affiliate Manager (All-in-One)

Dashboard monitoring & manajemen afiliator Shopee (AMS) multi-toko.  
**Dark mode profesional + aksen orange.** Siap deploy di **EasyPanel** + **PostgreSQL**.

---

## Fitur

- Multi toko (token per shop disimpan di PostgreSQL)
- KPI: GMV, Order, Komisi, ROI, Klik, Afiliator Aktif
- Ranking Top 5 + tabel lengkap + search + filter channel
- Campaign list
- Sync manual per toko → tarik data dari Shopee AMS API
- Mode **mock** (langsung jalan tanpa API) & **live**
- Frontend + Backend 1 service

---

## Deploy di EasyPanel

### 1. Buat Database PostgreSQL
- Service → **PostgreSQL**
- Catat: host, port, user, password, database name
- Setelah jalan, jalankan schema:
  - Buka **Terminal** service Postgres atau pakai adminer
  - Copy-paste isi file `database/schema.sql`

### 2. Buat App (Node.js)
- **App** → Source: upload zip / Git / Docker
- Build method: **Dockerfile** (ada di root)
- Port: **3000**
- Environment variables:

```
NODE_ENV=production
PORT=3000
APP_MODE=mock

DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME

SHOPEE_PARTNER_ID=200xxxx
SHOPEE_PARTNER_KEY=your_key
SHOPEE_REGION=ID
SHOPEE_BASE_URL=https://partner.shopeemobile.com
```

- Link ke service PostgreSQL (EasyPanel biasanya otomatis isi `DATABASE_URL`)

### 3. Init Schema
Setelah container app & postgres running:

```bash
# Di terminal app container
node src/db-init.js
```

Atau jalankan SQL manual dari `database/schema.sql`.

### 4. Buka domain
EasyPanel → Domain → point ke app port 3000.

---

## Local Development

```bash
# 1. Postgres (atau pakai docker-compose)
docker compose up -d postgres

# 2. Env
cp .env.example .env
# edit DATABASE_URL dll

# 3. Backend
cd backend
npm install
npm run db:init
npm start

# Buka http://localhost:3000
```

Atau full docker:

```bash
docker compose up --build
```

---

## Alur Integrasi API Real

1. Daftar App di [Shopee Open Platform](https://open.shopee.com/)  
   Tipe: **Affiliate Marketing Solution Management**

2. Isi environment:
   ```
   APP_MODE=live
   SHOPEE_PARTNER_ID=...
   SHOPEE_PARTNER_KEY=...
   ```

3. Authorization tiap toko (OAuth Shopee) → dapat `code` → tukar jadi `access_token` + `refresh_token`

4. Simpan token:
   ```http
   POST /api/shops
   {
     "shop_id": 123456,
     "shop_name": "Toko Saya",
     "region": "ID",
     "access_token": "...",
     "refresh_token": "...",
     "expire_in": 14400
   }
   ```

5. Klik **Sync** di halaman Toko Saya → data afiliator masuk DB & muncul di dashboard.

---

## Struktur

```
shopee-affiliate-app/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server
│   │   ├── db.js
│   │   ├── db-init.js
│   │   ├── routes/api.js
│   │   └── services/shopee.js
│   ├── package.json
│   └── Dockerfile
├── frontend/                 # Dark dashboard
│   ├── index.html
│   └── js/
├── database/
│   └── schema.sql
├── Dockerfile                # Root (untuk EasyPanel)
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## API Endpoints (internal)

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/health` | Health check |
| GET | `/api/shops` | Daftar toko |
| POST | `/api/shops` | Tambah/update token toko |
| GET | `/api/affiliates` | List + performa |
| GET | `/api/campaigns` | Campaign |
| GET | `/api/dashboard/summary` | KPI summary |
| POST | `/api/sync/:shopId` | Tarik data AMS real |

---

Siap dipakai. Setelah deploy, ganti `APP_MODE=live` dan masukkan token toko.
