# Hub del Facilitador — LHH Presencia Ejecutiva

App web para gestionar programas de Presencia Ejecutiva: configura clientes, instrumentos y participantes; genera links públicos de evaluación.

## Stack

- **Node.js + Express** — servidor web
- **PostgreSQL** — base de datos (provista por Railway)
- **Vanilla JS** — frontend sin dependencias de framework

## Despliegue en Railway

### 1. Subir el código a GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/presencia-ejecutiva-hub.git
git push -u origin main
```

### 2. Crear proyecto en Railway

1. Ir a [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Seleccionar el repositorio
3. Railway detecta Node.js automáticamente y corre `npm start`

### 3. Agregar PostgreSQL

1. En el proyecto de Railway → **+ New** → **Database** → **Add PostgreSQL**
2. Railway conecta automáticamente `DATABASE_URL` al servicio

### 4. Variables de entorno

En Railway → tu servicio → **Variables**:

| Variable | Valor |
|---|---|
| `HUB_PASSWORD` | contraseña que usará Catalina |
| `SESSION_SECRET` | cadena aleatoria larga (genera una con `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |

`DATABASE_URL` la agrega Railway automáticamente — no la toques.

### 5. Deploy

Railway hace deploy automático al hacer push a `main`. El primer deploy crea las tablas en la base de datos.

---

## URLs

| Ruta | Descripción |
|---|---|
| `/` | Hub del facilitador (requiere contraseña) |
| `/login` | Pantalla de acceso |
| `/p/:programId` | Formulario público para participantes |

## Uso

1. **Catalina** entra a `/` con la contraseña configurada
2. Crea un programa → elige instrumentos → agrega participantes
3. Copia el link de participante (`/p/:id`) y lo envía a los evaluadores
4. Los evaluadores abren el link, llenan la evaluación F&R y envían
5. Los resultados aparecen en tiempo real en el panel de detalle del hub

## Local (desarrollo)

```bash
npm install
# Crea un archivo .env copiando .env.example y completando DATABASE_URL local
npm run dev
```
