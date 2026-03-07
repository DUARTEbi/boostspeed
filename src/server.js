require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const https   = require('https');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Base de datos ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Crear tablas ──────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id                 SERIAL PRIMARY KEY,
        uid                VARCHAR(20)  UNIQUE NOT NULL,
        username           VARCHAR(50)  UNIQUE NOT NULL,
        password           TEXT         NOT NULL,
        contact            VARCHAR(100) NOT NULL,
        plan_activo        BOOLEAN      DEFAULT false,
        plan_nombre        VARCHAR(100) DEFAULT 'Sin plan',
        plan_tipo          VARCHAR(20)  DEFAULT 'dias',
        likes_disponibles  INTEGER      DEFAULT 0,
        likes_limite_plan  INTEGER      DEFAULT 0,
        likes_enviados_plan INTEGER     DEFAULT 0,
        envios_por_dia     INTEGER      DEFAULT 0,
        envios_hoy         INTEGER      DEFAULT 0,
        fecha_ultimo_envio DATE,
        plan_vence         TIMESTAMP,
        ilimitado          BOOLEAN      DEFAULT false,
        creado_en          TIMESTAMP    DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS codigos (
        id          SERIAL PRIMARY KEY,
        codigo      VARCHAR(20) UNIQUE NOT NULL,
        tipo        VARCHAR(20)  DEFAULT 'dias',
        dias        INTEGER NOT NULL DEFAULT 0,
        likes       INTEGER NOT NULL DEFAULT 0,
        envios_dia  INTEGER NOT NULL,
        ilimitado   BOOLEAN   DEFAULT false,
        usado       BOOLEAN   DEFAULT false,
        usado_por   VARCHAR(20),
        usado_en    TIMESTAMP,
        creado_en   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS historial (
        id              SERIAL PRIMARY KEY,
        usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        ff_uid          VARCHAR(30) NOT NULL,
        player_name     VARCHAR(100),
        likes_antes     INTEGER,
        likes_despues   INTEGER,
        likes_agregados INTEGER,
        nivel           INTEGER,
        region          VARCHAR(10),
        fecha           TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS codigos_recuperacion (
        id          SERIAL PRIMARY KEY,
        usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        codigo      VARCHAR(20) UNIQUE NOT NULL,
        usado       BOOLEAN DEFAULT false,
        creado_en   TIMESTAMP DEFAULT NOW(),
        expira_en   TIMESTAMP DEFAULT NOW() + INTERVAL '48 hours'
      );

      CREATE TABLE IF NOT EXISTS notificaciones_likes (
        id              SERIAL PRIMARY KEY,
        username        VARCHAR(50) NOT NULL,
        ff_uid          VARCHAR(30),
        player_name     VARCHAR(100),
        likes_agregados INTEGER,
        creado_en       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_mensajes (
        id          SERIAL PRIMARY KEY,
        usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        username    VARCHAR(50) NOT NULL,
        mensaje     TEXT NOT NULL,
        creado_en   TIMESTAMP DEFAULT NOW()
      );

      -- Agregar columnas si no existen (para bases de datos existentes)
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plan_tipo VARCHAR(20) DEFAULT 'dias';
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS likes_limite_plan INTEGER DEFAULT 0;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS likes_enviados_plan INTEGER DEFAULT 0;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ilimitado BOOLEAN DEFAULT false;
      ALTER TABLE codigos ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'dias';
      ALTER TABLE codigos ADD COLUMN IF NOT EXISTS ilimitado BOOLEAN DEFAULT false;
    `);
    console.log('✅ Base de datos lista');
  } finally {
    client.release();
  }
}

// ── Helpers ───────────────────────────────────────────────────
function genUID() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'BS-';
  for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function genCodigo(custom) {
  if (custom && custom.trim()) return custom.trim().toUpperCase();
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 8; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'bs_secret_2026');
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}
function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET || 'bs_secret_2026');
    if (!d.isAdmin) return res.status(403).json({ error: 'Acceso denegado' });
    req.user = d;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ── API de Free Fire ──────────────────────────────────────────
function llamarApiFF(uid, server = 'BR') {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FF_API_KEY;
    const apiBase = process.env.FF_API_URL || 'https://rtpysistemsapi.squareweb.app';

    if (!apiKey) {
      return reject(new Error('FF_API_KEY no configurada en variables de entorno'));
    }

    const params = `uid=${encodeURIComponent(uid)}&apikey=${encodeURIComponent(apiKey)}&server=${encodeURIComponent(server)}`;
    const fullUrl = `${apiBase}/like?${params}`;

    console.log(`[API FF] Llamando: ${apiBase}/like?uid=${uid}&server=${server}&apikey=***`);

    const req = https.get(fullUrl, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[API FF] Status HTTP: ${res.statusCode} | Respuesta: ${data.slice(0, 200)}`);
        try {
          const parsed = JSON.parse(data);
          parsed._httpStatus = res.statusCode;
          resolve(parsed);
        } catch {
          reject(new Error(`Respuesta inválida de la API: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[API FF] Error de conexión:`, err.message);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tiempo de espera agotado (30s)'));
    });
  });
}

function interpretarRespuestaFF(apiData) {
  const status      = apiData.status;
  const added       = parseInt(apiData.likes_added  || 0, 10);
  const successful  = parseInt(apiData.successful_likes || 0, 10);
  const before      = parseInt(apiData.likes_before || 0, 10);
  const after       = parseInt(apiData.likes_after  || 0, 10);
  const msgRaw      = String((apiData.message || '') + (apiData.error || '')).toLowerCase();

  if (apiData._httpStatus === 429 || apiData._limit === true ||
      ['limit','already','wait','espera','daily'].some(k => msgRaw.includes(k))) {
    return { tipo: 'limite', data: apiData };
  }

  if (apiData._httpStatus === 401 || msgRaw.includes('api key') || msgRaw.includes('apikey') ||
      msgRaw.includes('unauthorized') || msgRaw.includes('access denied') || msgRaw.includes('denegado')) {
    return { tipo: 'auth_error', data: apiData };
  }

  if (status === 1 || added > 0 || successful > 0) {
    // Verificar si los likes realmente aumentaron
    if (after > 0 && before > 0 && after <= before) {
      return { tipo: 'ya_recibio', data: apiData };
    }
    // Caso: la API reporta added/successful pero likes_after == likes_before (no cambió)
    if (after > 0 && before > 0 && after === before) {
      return { tipo: 'ya_recibio', data: apiData };
    }
    return { tipo: 'ok', data: apiData };
  }

  // Si status=1 pero likes no cambiaron
  if (status === 1 && after > 0 && before > 0 && after === before) {
    return { tipo: 'ya_recibio', data: apiData };
  }

  return { tipo: 'error', data: apiData };
}

// ════════════════════════════════════════════════════════════════
//  PÚBLICO
// ════════════════════════════════════════════════════════════════

app.get('/api/public-stats', async (req, res) => {
  try {
    const [usuarios, likesTotal, likesHoy] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM usuarios'),
      pool.query('SELECT COALESCE(SUM(likes_agregados),0) AS total FROM historial'),
      pool.query(`SELECT COALESCE(SUM(likes_agregados),0) AS total FROM historial WHERE fecha::date = CURRENT_DATE`),
    ]);
    res.json({
      ok: true,
      usuarios:   parseInt(usuarios.rows[0].count, 10),
      likes:      parseInt(likesTotal.rows[0].total, 10),
      likes_hoy:  parseInt(likesHoy.rows[0].total, 10),
    });
  } catch (err) {
    res.json({ ok: false, usuarios: 0, likes: 0, likes_hoy: 0 });
  }
});

// TOP usuarios (excluye ilimitados)
app.get('/api/top-usuarios', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.username, COALESCE(SUM(h.likes_agregados), 0) AS total_likes
      FROM usuarios u
      LEFT JOIN historial h ON h.usuario_id = u.id
      WHERE u.ilimitado = false
      GROUP BY u.id, u.username
      HAVING COALESCE(SUM(h.likes_agregados), 0) > 0
      ORDER BY total_likes DESC
      LIMIT 10
    `);
    res.json({ ok: true, top: r.rows });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, top: [] });
  }
});

// Stats del día para admin (envíos realizados hoy en total)
app.get('/api/admin/envios-hoy', adminMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT COUNT(*) AS total FROM historial WHERE fecha::date = $1`,
      [today]
    );
    res.json({ ok: true, envios_hoy: parseInt(r.rows[0].total, 10) });
  } catch (err) {
    res.json({ ok: false, envios_hoy: 0 });
  }
});

// ════════════════════════════════════════════════════════════════
//  USUARIOS
// ════════════════════════════════════════════════════════════════

app.post('/api/registro', async (req, res) => {
  try {
    const { username, password, contact } = req.body;
    if (!username || !password || !contact)
      return res.status(400).json({ error: 'Completa todos los campos' });
    if (username.length < 3)
      return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
    if (password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });

    const existe = await pool.query('SELECT id FROM usuarios WHERE LOWER(username)=LOWER($1)', [username]);
    if (existe.rows.length)
      return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });

    const hash = await bcrypt.hash(password, 10);
    let uid, intentos = 0;
    do {
      uid = genUID();
      const chk = await pool.query('SELECT id FROM usuarios WHERE uid=$1', [uid]);
      if (!chk.rows.length) break;
    } while (++intentos < 20);

    const result = await pool.query(
      `INSERT INTO usuarios (uid,username,password,contact) VALUES ($1,$2,$3,$4)
       RETURNING id,uid,username,contact,plan_activo,plan_nombre,likes_disponibles,envios_por_dia,plan_vence,creado_en`,
      [uid, username, hash, contact]
    );
    const user = result.rows[0];
    // Token de larga duración (1 año) para sesión permanente
    const token = jwt.sign(
      { id: user.id, uid: user.uid, username: user.username },
      process.env.JWT_SECRET || 'bs_secret_2026',
      { expiresIn: '365d' }
    );
    res.json({ ok: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Ingresa usuario y contraseña' });

    const result = await pool.query('SELECT * FROM usuarios WHERE LOWER(username)=LOWER($1)', [username]);
    if (!result.rows.length)
      return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

    // Token de larga duración (1 año) para sesión permanente
    const token = jwt.sign(
      { id: user.id, uid: user.uid, username: user.username },
      process.env.JWT_SECRET || 'bs_secret_2026',
      { expiresIn: '365d' }
    );
    const { password: _, ...userSafe } = user;
    res.json({ ok: true, token, user: userSafe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/recuperar', async (req, res) => {
  try {
    const { contact } = req.body;
    if (!contact) return res.status(400).json({ error: 'Ingresa tu correo o teléfono' });

    const result = await pool.query('SELECT uid, username FROM usuarios WHERE contact=$1', [contact]);
    if (!result.rows.length)
      return res.status(404).json({ error: 'No se encontró ninguna cuenta con ese contacto' });

    const u = result.rows[0];
    res.json({
      ok: true,
      message: `Tu usuario es "${u.username}" y tu ID único es: ${u.uid}. Contacta al administrador para recuperar tu contraseña.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Recuperar - verificar contacto (paso 1 del dashboard)
app.post('/api/recuperar-check', async (req, res) => {
  try {
    const { contact } = req.body;
    if (!contact) return res.status(400).json({ error: 'Ingresa tu correo o teléfono' });
    const r = await pool.query('SELECT id, uid, username FROM usuarios WHERE contact=$1', [contact]);
    if (!r.rows.length) return res.status(404).json({ error: 'No se encontró cuenta con ese contacto' });
    const u = r.rows[0];
    res.json({ ok: true, userId: u.id, username: u.username, uid: u.uid });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Recuperar - verificar código (paso 2)
app.post('/api/recuperar-verificar', async (req, res) => {
  try {
    const { userId, codigo } = req.body;
    if (!userId || !codigo) return res.status(400).json({ error: 'Datos incompletos' });
    const r = await pool.query(
      `SELECT * FROM codigos_recuperacion WHERE usuario_id=$1 AND codigo=$2 AND usado=false AND expira_en > NOW()`,
      [userId, codigo.toUpperCase()]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Código inválido o expirado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Recuperar - cambiar contraseña (paso 3)
app.post('/api/recuperar-cambiar', async (req, res) => {
  try {
    const { userId, password_nueva } = req.body;
    if (!userId || !password_nueva) return res.status(400).json({ error: 'Datos incompletos' });
    if (password_nueva.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });
    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query('UPDATE usuarios SET password=$1 WHERE id=$2', [hash, userId]);
    await pool.query('UPDATE codigos_recuperacion SET usado=true WHERE usuario_id=$1', [userId]);
    res.json({ ok: true, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/perfil', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `UPDATE usuarios SET envios_hoy=0, fecha_ultimo_envio=$1
       WHERE id=$2 AND (fecha_ultimo_envio IS NULL OR fecha_ultimo_envio < $1)`,
      [today, req.user.id]
    );
    const result = await pool.query(
      `SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,
       likes_disponibles,likes_limite_plan,likes_enviados_plan,
       envios_por_dia,envios_hoy,plan_vence,ilimitado,creado_en
       FROM usuarios WHERE id=$1`,
      [req.user.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = result.rows[0];
    if (u.plan_activo && !u.ilimitado && u.plan_tipo === 'dias' && u.plan_vence && new Date(u.plan_vence) < new Date()) {
      await pool.query('UPDATE usuarios SET plan_activo=false WHERE id=$1', [u.id]);
      u.plan_activo = false;
    }
    const hist = await pool.query(
      `SELECT ff_uid,player_name,likes_antes,likes_despues,likes_agregados,nivel,region,fecha
       FROM historial WHERE usuario_id=$1 ORDER BY fecha DESC LIMIT 30`,
      [req.user.id]
    );
    // Total likes enviados por el usuario
    const totalLikes = await pool.query(
      `SELECT COALESCE(SUM(likes_agregados),0) AS total FROM historial WHERE usuario_id=$1`,
      [req.user.id]
    );
    u.total_likes_enviados = parseInt(totalLikes.rows[0].total, 10);
    res.json({ ok: true, user: u, historial: hist.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/canjear', authMiddleware, async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Ingresa un código' });

    const codResult = await pool.query('SELECT * FROM codigos WHERE codigo=$1', [codigo.toUpperCase()]);
    if (!codResult.rows.length)
      return res.status(400).json({ error: 'Código inválido o inexistente' });

    const cod = codResult.rows[0];
    if (cod.usado && !cod.ilimitado) return res.status(400).json({ error: 'Este código ya fue utilizado' });

    const user = await pool.query('SELECT uid FROM usuarios WHERE id=$1', [req.user.id]);

    if (cod.ilimitado) {
      // Plan ilimitado — envios_por_dia=999, likes_disponibles=999999 (interno, no se muestra)
      await pool.query(
        `UPDATE usuarios SET plan_activo=true, plan_nombre='Plan Ilimitado',
         plan_tipo='ilimitado', likes_disponibles=999999, likes_limite_plan=999999,
         likes_enviados_plan=0, envios_por_dia=999,
         plan_vence=NULL, ilimitado=true WHERE id=$1`,
        [req.user.id]
      );
      res.json({ ok: true, message: '🚀 Plan Ilimitado activado correctamente' });

    } else if (cod.tipo === 'likes') {
      // Plan por likes — likes_disponibles = total de likes del plan
      // likes_limite_plan = total original para calcular progreso
      await pool.query(
        `UPDATE usuarios SET plan_activo=true, plan_nombre=$1, plan_tipo='likes',
         likes_disponibles=$2, likes_limite_plan=$2,
         likes_enviados_plan=0, envios_por_dia=$3,
         plan_vence=NULL, ilimitado=false WHERE id=$4`,
        [`Plan ${cod.likes} Likes`, cod.likes, cod.envios_dia, req.user.id]
      );
      await pool.query(
        'UPDATE codigos SET usado=true, usado_por=$1, usado_en=NOW() WHERE codigo=$2',
        [user.rows[0].uid, cod.codigo]
      );
      res.json({
        ok: true,
        message: `✅ Plan activado: ${cod.likes.toLocaleString()} likes · ${cod.envios_dia} envíos/día`
      });

    } else {
      // Plan por días — NO necesita likes_disponibles para enviar
      // likes_disponibles se usa internamente para contar cuántos likes SE HAN ENVIADO
      const vence = new Date(Date.now() + cod.dias * 86400000).toISOString();
      await pool.query(
        `UPDATE usuarios SET plan_activo=true, plan_nombre=$1, plan_tipo='dias',
         likes_disponibles=0, likes_limite_plan=0,
         likes_enviados_plan=0, envios_por_dia=$2,
         plan_vence=$3, ilimitado=false WHERE id=$4`,
        [`Plan ${cod.dias} días`, cod.envios_dia, vence, req.user.id]
      );
      await pool.query(
        'UPDATE codigos SET usado=true, usado_por=$1, usado_en=NOW() WHERE codigo=$2',
        [user.rows[0].uid, cod.codigo]
      );
      res.json({
        ok: true,
        message: `✅ Plan activado: ${cod.dias} días · ${cod.envios_dia} envíos/día`
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/enviar-likes', authMiddleware, async (req, res) => {
  try {
    const { ff_uid, server = 'BR' } = req.body;
    if (!ff_uid) return res.status(400).json({ error: 'Ingresa el UID de Free Fire' });
    if (!/^\d+$/.test(ff_uid.trim()))
      return res.status(400).json({ error: 'El UID solo debe contener números' });

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `UPDATE usuarios SET envios_hoy=0, fecha_ultimo_envio=$1
       WHERE id=$2 AND (fecha_ultimo_envio IS NULL OR fecha_ultimo_envio < $1)`,
      [today, req.user.id]
    );

    const result = await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.user.id]);
    const u = result.rows[0];

    if (!u.plan_activo)
      return res.status(400).json({ error: 'Necesitas un plan activo para enviar likes' });

    if (!u.ilimitado) {
      // Verificar vencimiento por días
      if (u.plan_tipo === 'dias' && u.plan_vence && new Date(u.plan_vence) < new Date()) {
        await pool.query('UPDATE usuarios SET plan_activo=false WHERE id=$1', [u.id]);
        return res.status(400).json({ error: 'Tu plan de días ha vencido. Canjea un nuevo código.' });
      }
      // Verificar límite diario de envíos
      if (u.envios_hoy >= u.envios_por_dia)
        return res.status(400).json({
          error: `Límite diario alcanzado (${u.envios_por_dia} envíos/día). Vuelve mañana.`
        });
      // Solo plan por likes verifica likes_disponibles
      if (u.plan_tipo === 'likes' && u.likes_disponibles <= 0) {
        await pool.query('UPDATE usuarios SET plan_activo=false WHERE id=$1', [u.id]);
        return res.status(400).json({ error: 'Has completado todos tus likes del plan. ¡Plan finalizado!' });
      }
    }

    const serverUpper = (server || 'BR').toUpperCase();
    const serversValidos = ['BR', 'IND', 'US', 'SAC', 'NA'];
    const serverFinal = serversValidos.includes(serverUpper) ? serverUpper : 'BR';

    let apiData;
    try {
      apiData = await llamarApiFF(ff_uid.trim(), serverFinal);
    } catch (apiErr) {
      console.error('[enviar-likes] Error API:', apiErr.message);
      return res.status(500).json({ error: 'Error al contactar la API: ' + apiErr.message });
    }

    const interpretado = interpretarRespuestaFF(apiData);
    console.log(`[enviar-likes] Interpretación: ${interpretado.tipo}`, apiData);

    if (interpretado.tipo === 'auth_error') {
      return res.status(500).json({
        error: '❌ Error de autenticación con la API. Verifica que FF_API_KEY esté configurada.'
      });
    }
    if (interpretado.tipo === 'limite') {
      return res.status(400).json({
        error: '⚠️ Este ID ya recibió likes recientemente. Intenta en unas horas.'
      });
    }
    if (interpretado.tipo === 'ya_recibio') {
      const d = apiData;
      const player = d.player || d.nickname || ff_uid.trim();
      const level  = d.level  || '—';
      const region = d.region || serverFinal;
      const before = parseInt(d.likes_before || 0, 10);
      const ahora = new Date();
      const manana = new Date(ahora); manana.setDate(manana.getDate()+1); manana.setHours(0,0,0,0);
      const diffMs = manana - ahora;
      const horas = Math.floor(diffMs/3600000), mins = Math.floor((diffMs%3600000)/60000);
      const tiempoRestante = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
      return res.status(400).json({
        error: `Este UID ya recibió likes hoy. Disponible en ${tiempoRestante}.`,
        data: { jugador:player, uid:d.uid||ff_uid.trim(), nivel:level, region, likes_antes:before, likes_despues:before, likes_agregados:0, tiempo_restante:tiempoRestante, ya_recibio:true }
      });
    }
    if (interpretado.tipo === 'error') {
      const motivo = apiData.message || apiData.error || 'UID no encontrado o respuesta inesperada';
      return res.status(400).json({ error: '❌ ' + motivo });
    }

    const d = apiData;
    const likesAdded = Math.min(
      parseInt(d.likes_added || 0, 10) || parseInt(d.successful_likes || 0, 10), 230
    );
    const player = d.player || d.nickname || ff_uid.trim();
    const level  = d.level  || '—';
    const region = d.region || serverFinal;
    const before = parseInt(d.likes_before || 0, 10);
    const after  = parseInt(d.likes_after  || 0, 10);
    const tiempo = d.processing_time_seconds ? `${d.processing_time_seconds}s` : '—';

    if (likesAdded > 0 || after > before) {
      if (u.ilimitado) {
        await pool.query(
          `UPDATE usuarios SET envios_hoy=envios_hoy+1, likes_enviados_plan=likes_enviados_plan+$1, fecha_ultimo_envio=$2 WHERE id=$3`,
          [likesAdded, today, req.user.id]
        );
      } else if (u.plan_tipo === 'likes') {
        const newDisp = Math.max((u.likes_disponibles||0) - likesAdded, 0);
        const newEnv  = (u.likes_enviados_plan||0) + likesAdded;
        // Si se agotaron los likes, desactivar plan automáticamente
        const planSigue = newDisp > 0;
        await pool.query(
          `UPDATE usuarios SET envios_hoy=envios_hoy+1,
           likes_disponibles=$1, likes_enviados_plan=$2,
           plan_activo=$3, fecha_ultimo_envio=$4 WHERE id=$5`,
          [newDisp, newEnv, planSigue, today, req.user.id]
        );
      } else {
        // Plan por días — sólo incrementa envios_hoy y lleva registro de cuántos likes se enviaron
        await pool.query(
          `UPDATE usuarios SET envios_hoy=envios_hoy+1,
           likes_enviados_plan=likes_enviados_plan+$1,
           fecha_ultimo_envio=$2 WHERE id=$3`,
          [likesAdded, today, req.user.id]
        );
      }

      await pool.query(
        `INSERT INTO historial (usuario_id,ff_uid,player_name,likes_antes,likes_despues,likes_agregados,nivel,region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.user.id, ff_uid.trim(), player, before, after, likesAdded, level, region]
      );

      // Guardar última notificación para feed de landing
      try {
        await pool.query(
          `INSERT INTO notificaciones_likes (username, ff_uid, player_name, likes_agregados)
           VALUES ($1,$2,$3,$4)`,
          [u.username, ff_uid.trim(), player, likesAdded]
        );
      } catch(_) {} // tabla puede no existir aún, no bloquear
    }

    res.json({
      ok: true,
      data: { jugador:player, uid:d.uid||ff_uid.trim(), nivel:level, region, likes_antes:before, likes_despues:after, likes_agregados:likesAdded, tiempo },
      message: `✅ ¡${likesAdded} likes enviados a ${player}!`
    });
  } catch (err) {
    console.error('[enviar-likes] Error interno:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.post('/api/cambiar-pass', authMiddleware, async (req, res) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva)
      return res.status(400).json({ error: 'Completa ambos campos' });
    if (password_nueva.length < 6)
      return res.status(400).json({ error: 'Mínimo 6 caracteres' });

    const result = await pool.query('SELECT password FROM usuarios WHERE id=$1', [req.user.id]);
    if (!await bcrypt.compare(password_actual, result.rows[0].password))
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });

    await pool.query(
      'UPDATE usuarios SET password=$1 WHERE id=$2',
      [await bcrypt.hash(password_nueva, 10), req.user.id]
    );
    res.json({ ok: true, message: '✅ Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════════

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (
    username !== (process.env.ADMIN_USER || 'admin') ||
    password !== (process.env.ADMIN_PASS || 'boostspeed2026')
  ) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign(
    { isAdmin: true, username },
    process.env.JWT_SECRET || 'bs_secret_2026',
    { expiresIn: '30d' }
  );
  res.json({ ok: true, token });
});

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [tu, tc, uc, ap, ru, envHoy] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM usuarios'),
      pool.query('SELECT COUNT(*) FROM codigos'),
      pool.query('SELECT COUNT(*) FROM codigos WHERE usado=true'),
      pool.query('SELECT COUNT(*) FROM usuarios WHERE plan_activo=true'),
      pool.query(`SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,likes_disponibles,ilimitado,creado_en
                  FROM usuarios ORDER BY creado_en DESC LIMIT 10`),
      pool.query(`SELECT COUNT(*) AS total FROM historial WHERE fecha::date = $1`, [today]),
    ]);
    res.json({
      ok: true,
      totalUsuarios:    parseInt(tu.rows[0].count, 10),
      totalCodigos:     parseInt(tc.rows[0].count, 10),
      codigosUsados:    parseInt(uc.rows[0].count, 10),
      planesActivos:    parseInt(ap.rows[0].count, 10),
      enviosHoy:        parseInt(envHoy.rows[0].total, 10),
      limiteApiDia:     parseInt(process.env.FF_API_LIMIT_DIA || 0, 10),
      usuariosRecientes: ru.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/admin/codigos', adminMiddleware, async (req, res) => {
  try {
    const { tipo, dias, likes, envios_dia, custom, ilimitado } = req.body;

    if (ilimitado) {
      // Código ilimitado
      let codigo, intentos = 0;
      do {
        codigo = genCodigo(intentos === 0 ? custom : '');
        const chk = await pool.query('SELECT id FROM codigos WHERE codigo=$1', [codigo]);
        if (!chk.rows.length) break;
      } while (++intentos < 20);

      const result = await pool.query(
        `INSERT INTO codigos (codigo, tipo, dias, likes, envios_dia, ilimitado)
         VALUES ($1, 'ilimitado', 0, 0, 999, true) RETURNING *`,
        [codigo]
      );
      return res.json({ ok: true, codigo: result.rows[0] });
    }

    if (!envios_dia)
      return res.status(400).json({ error: 'Completa todos los campos' });

    const tipoFinal = tipo === 'likes' ? 'likes' : 'dias';
    if (tipoFinal === 'dias' && !dias)
      return res.status(400).json({ error: 'Ingresa los días del plan' });
    if (tipoFinal === 'likes' && !likes)
      return res.status(400).json({ error: 'Ingresa la cantidad de likes' });

    let codigo, intentos = 0;
    do {
      codigo = genCodigo(intentos === 0 ? custom : '');
      const chk = await pool.query('SELECT id FROM codigos WHERE codigo=$1', [codigo]);
      if (!chk.rows.length) break;
    } while (++intentos < 20);

    const result = await pool.query(
      `INSERT INTO codigos (codigo, tipo, dias, likes, envios_dia)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [codigo, tipoFinal, tipoFinal === 'dias' ? dias : 0, tipoFinal === 'likes' ? likes : 0, envios_dia]
    );
    res.json({ ok: true, codigo: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código ya existe' });
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/admin/codigos', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM codigos ORDER BY creado_en DESC');
    res.json({ ok: true, codigos: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/admin/codigos/:codigo', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM codigos WHERE codigo=$1', [req.params.codigo]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/admin/usuarios', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,likes_disponibles,
       likes_limite_plan,likes_enviados_plan,envios_por_dia,envios_hoy,plan_vence,ilimitado,creado_en
       FROM usuarios ORDER BY creado_en DESC`
    );
    res.json({ ok: true, usuarios: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/admin/usuarios/buscar', adminMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const r = await pool.query(
      `SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,likes_disponibles,
       likes_limite_plan,likes_enviados_plan,envios_por_dia,envios_hoy,plan_vence,ilimitado,creado_en
       FROM usuarios WHERE uid ILIKE $1 OR LOWER(username) ILIKE LOWER($1) LIMIT 10`,
      [`%${q}%`]
    );
    res.json({ ok: true, usuarios: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/admin/usuarios/:id', adminMiddleware, async (req, res) => {
  try {
    const { dias_adicionales, envios_por_dia, plan_activo, plan_tipo, likes_adicionales } = req.body;
    const id = req.params.id;

    // Get current user state
    const cur = await pool.query('SELECT * FROM usuarios WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = cur.rows[0];

    let sets = [], params = [];
    let idx = 1;

    // Siempre actualizar plan_activo y envios_por_dia
    sets.push(`plan_activo=$${idx++}`); params.push(plan_activo !== undefined ? plan_activo : u.plan_activo);
    sets.push(`envios_por_dia=$${idx++}`); params.push(envios_por_dia || u.envios_por_dia);

    const tipoPlan = plan_tipo || u.plan_tipo || 'dias';

    if (plan_activo && dias_adicionales > 0) {
      // Extender por días desde ahora (o desde vencimiento actual si aún no vence)
      const base = (u.plan_vence && new Date(u.plan_vence) > new Date()) ? new Date(u.plan_vence) : new Date();
      const vence = new Date(base.getTime() + dias_adicionales * 86400000).toISOString();
      sets.push(`plan_vence=$${idx++}`); params.push(vence);
      sets.push(`plan_tipo=$${idx++}`); params.push('dias');
      sets.push(`plan_nombre=$${idx++}`); params.push(`Plan ${dias_adicionales} días (Admin)`);
    } else if (!plan_activo) {
      sets.push(`plan_vence=$${idx++}`); params.push(null);
    }

    // Si es plan por likes, agregar likes adicionales
    if (likes_adicionales > 0) {
      const newDisp = (u.likes_disponibles||0) + likes_adicionales;
      sets.push(`likes_disponibles=$${idx++}`); params.push(newDisp);
      sets.push(`likes_limite_plan=$${idx++}`); params.push(newDisp);
      sets.push(`likes_enviados_plan=$${idx++}`); params.push(0);
      sets.push(`plan_tipo=$${idx++}`); params.push('likes');
      sets.push(`plan_nombre=$${idx++}`); params.push(`Plan ${likes_adicionales} Likes (Admin)`);
      sets.push(`plan_vence=$${idx++}`); params.push(null);
    }

    params.push(id);
    await pool.query(`UPDATE usuarios SET ${sets.join(',')} WHERE id=$${idx}`, params);

    const updated = await pool.query(
      `SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,likes_disponibles,
       likes_limite_plan,likes_enviados_plan,envios_por_dia,envios_hoy,plan_vence,ilimitado,creado_en
       FROM usuarios WHERE id=$1`, [id]
    );
    res.json({ ok: true, usuario: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint dedicado para asignar plan ilimitado
app.put('/api/admin/usuarios/:id/ilimitado', adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query(
      `UPDATE usuarios SET plan_activo=true, plan_nombre='Plan Ilimitado',
       plan_tipo='ilimitado', likes_disponibles=999999, likes_limite_plan=999999,
       likes_enviados_plan=0, envios_por_dia=999, plan_vence=NULL, ilimitado=true
       WHERE id=$1`, [id]
    );
    const updated = await pool.query(
      `SELECT id,uid,username,contact,plan_activo,plan_nombre,plan_tipo,likes_disponibles,
       likes_limite_plan,likes_enviados_plan,envios_por_dia,envios_hoy,plan_vence,ilimitado,creado_en
       FROM usuarios WHERE id=$1`, [id]
    );
    res.json({ ok: true, usuario: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/admin/usuarios/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Generar código de recuperación (admin)
app.post('/api/admin/codigos-recuperacion', adminMiddleware, async (req, res) => {
  try {
    const { usuario_id, codigo_custom } = req.body;
    if (!usuario_id) return res.status(400).json({ error: 'Usuario requerido' });

    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = codigo_custom ? codigo_custom.trim().toUpperCase() : '';
    if (!codigo) { for (let i = 0; i < 8; i++) codigo += c[Math.floor(Math.random() * c.length)]; }

    // Invalida códigos anteriores del mismo usuario
    await pool.query('DELETE FROM codigos_recuperacion WHERE usuario_id=$1', [usuario_id]);
    await pool.query(
      `INSERT INTO codigos_recuperacion (usuario_id, codigo) VALUES ($1, $2)`,
      [usuario_id, codigo]
    );
    res.json({ ok: true, codigo });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
//  CHAT
// ════════════════════════════════════════════════════════════════

const PALABROTAS = [
  // Español
  'puta','puto','putos','putas','hijueputa','hijueputo','hp','gonorrea','gonorreas',
  'mierda','mierdas','culo','culos','verga','vergas','pendejo','pendejos','pendeja','pendejas',
  'marica','maricas','malparido','malparida','malparidos','hdp','idiota','idiotas',
  'estupido','estupidos','estupida','estupidas','estúpido','estúpida','retrasado','retrasada',
  'polla','pollas','coño','coños','joder','gilipollas','cabrón','cabron','cabrones',
  'follar','putero','putear','mamaguevo','mamaguevo','coger','cogelo','ojete',
  'chinga','chingada','chingadas','chingadera','culero','culeros','pinche','pinches',
  'cabeza de pene','weon','huevon','huevona','huevones','culiao','culiado','culiao',
  'hijodeputa','hijo de puta','hijo de perra','perra','perras','zorra','zorras',
  'pene','penes','vagina','vaginas','culo','trasero','ano',
  // Inglés
  'fuck','fucking','fucked','fucker','fuckers','shit','shits','shitty',
  'ass','asses','asshole','assholes','bitch','bitches','bastard','bastards',
  'crap','craps','damn','damned','cunt','cunts','dick','dicks','cock','cocks',
  'pussy','pussies','whore','whores','slut','sluts','nigger','niggers','nigga',
  'faggot','fag','fags','retard','retards','motherfucker','mofo',
  'bullshit','jackass','douchebag','dipshit',
  // Portugués
  'porra','caralho','foda','fodase','foda-se','viado','viadao','buceta','boceta',
  'merda','otario','otário','pau','cu','arrombado','cuzao','cuzão',
  // Variaciones leet/ofuscadas comunes
  'pu7a','put4','sh1t','f4ck','a55','@ss','b1tch','c0ño','v3rga','p3nd3jo',
];

// Normalizar texto para detectar ofuscación (l33tspeak, acentos, repetición)
function normalizarTexto(t) {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e')
    .replace(/4/g,'a').replace(/5/g,'s').replace(/7/g,'t')
    .replace(/8/g,'b').replace(/@/g,'a').replace(/\$/g,'s')
    .replace(/(.)\1{2,}/g,'$1') // aaaaa -> a (repetición)
    .replace(/[^a-z0-9\s]/g,' '); // resto a espacio
}

function filtrarMensaje(texto) {
  let t = texto.trim();
  if (!t || t.length < 1) return null;
  if (t.length > 200) t = t.slice(0, 200);

  // Bloquear URLs/links
  if (/https?:\/\/|www\.|\.com|\.net|\.org|\.io|\.co|t\.me|wa\.me|discord\.|bit\.ly/i.test(t)) return null;

  const normalizado = normalizarTexto(t);

  for (const p of PALABROTAS) {
    const pnorm = normalizarTexto(p);
    // Buscar como palabra completa O como subcadena (más estricto)
    const regex = new RegExp(`(^|\\s|[^a-z])${pnorm.replace(/\s+/g,'\\s*')}($|\\s|[^a-z])`, 'i');
    if (regex.test(normalizado) || normalizado.includes(pnorm)) return null;
  }

  return t;
}

// GET mensajes (últimos 20)
app.get('/api/chat', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, username, mensaje, creado_en FROM chat_mensajes
       WHERE creado_en > NOW() - INTERVAL '60 seconds'
       ORDER BY creado_en DESC LIMIT 20`
    );
    res.json({ ok: true, mensajes: r.rows.reverse() });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST mensaje
let cooldowns = {}; // userId -> timestamp último mensaje
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { mensaje } = req.body;
    const uid = req.user.id;
    // Cooldown 3 segundos
    const ahora = Date.now();
    if (cooldowns[uid] && ahora - cooldowns[uid] < 3000)
      return res.status(429).json({ error: 'Espera un momento antes de enviar otro mensaje' });
    cooldowns[uid] = ahora;

    const filtrado = filtrarMensaje(mensaje || '');
    if (!filtrado) {
      // Mensaje bloqueado — responder ok silenciosamente (el usuario no sabe que se descartó)
      return res.json({ ok: true, descartado: true });
    }

    const user = await pool.query('SELECT username FROM usuarios WHERE id=$1', [uid]);
    if (!user.rows.length) return res.status(400).json({ error: 'Usuario no encontrado' });

    await pool.query(
      `INSERT INTO chat_mensajes (usuario_id, username, mensaje) VALUES ($1, $2, $3)`,
      [uid, user.rows[0].username, filtrado]
    );

    // Mantener solo últimos 20 mensajes Y borrar los de más de 60 segundos
    await pool.query(
      `DELETE FROM chat_mensajes WHERE id NOT IN (SELECT id FROM chat_mensajes ORDER BY creado_en DESC LIMIT 20)
       OR creado_en < NOW() - INTERVAL '60 seconds'`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Notificaciones públicas para landing (últimos likes enviados)
app.get('/api/notificaciones-likes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT username, player_name, likes_agregados, creado_en
       FROM notificaciones_likes
       ORDER BY creado_en DESC LIMIT 20`
    );
    res.json({ ok: true, notificaciones: r.rows });
  } catch (err) {
    res.json({ ok: false, notificaciones: [] });
  }
});

// Fallback SPA
// ── AI SOPORTE CHAT ───────────────────────────────────────────────
app.post('/api/ai-chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Mensajes requeridos' });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API no configurada' });

    const SYSTEM = `Eres el asistente de soporte de BoostSpeed, una plataforma para enviar likes en Free Fire.

SOLO responde preguntas sobre la plataforma BoostSpeed. Si te preguntan algo ajeno (política, ciencia, chistes, otros juegos, etc.) responde amablemente que solo puedes ayudar con temas de BoostSpeed.

INFORMACIÓN DE LA PLATAFORMA:
- BoostSpeed permite enviar likes a perfiles de Free Fire de forma segura y rápida.
- Para usar la plataforma necesitas un PLAN DE ACCESO activado con un código.
- Los códigos se obtienen contactando al administrador por Telegram (@DuarteStoreX) o WhatsApp (+57 316 437 7140).
- Hay 3 tipos de plan: por DÍAS (X envíos por día durante N días), por LIKES (un total de likes a repartir), e ILIMITADO.
- Para enviar likes: ve a la pestaña "Likes", ingresa el UID de Free Fire del jugador y presiona Enviar.
- Solo puedes enviar likes a un mismo UID una vez cada 24 horas.
- El UID de Free Fire es el número de identificación del jugador, se encuentra en su perfil en el juego.
- El historial de envíos está en la pestaña "Historial".
- Para canjear un código: ve a la pestaña "Acceso" e ingresa el código en el campo correspondiente.
- Si olvidaste tu contraseña, contacta al administrador para un código de recuperación.
- El servicio es seguro, sin riesgo de ban. Disponible 24/7.
- No compartas tu contraseña ni tu código con nadie.
- El chat de la pestaña "Chat" es para hablar con otros usuarios de la plataforma.

Responde de forma breve, amigable y clara. Máximo 3 oraciones. No menciones APIs, tokens, base de datos, límites internos ni datos de otros usuarios.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM,
      messages: messages.slice(-8),
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const apiRes = await new Promise((resolve, reject) => {
      const req2 = https.request(options, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    const parsed = JSON.parse(apiRes.body);
    const reply = parsed.content?.[0]?.text || 'No pude procesar tu pregunta, intenta de nuevo.';
    res.json({ ok: true, reply });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Error interno del asistente' });
  }
});

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../public', 'index.html'))
);

// ── Iniciar ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 BoostSpeed corriendo en puerto ${PORT}`));
}).catch(err => {
  console.error('❌ Error conectando a la base de datos:', err.message);
  process.exit(1);
});
