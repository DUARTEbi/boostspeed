require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Base de datos (Railway PostgreSQL) ──────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Middlewares ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Crear tablas si no existen ────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id         SERIAL PRIMARY KEY,
      uid        VARCHAR(20)  UNIQUE NOT NULL,
      username   VARCHAR(50)  UNIQUE NOT NULL,
      password   TEXT         NOT NULL,
      contact    VARCHAR(100) NOT NULL,
      plan_activo     BOOLEAN   DEFAULT false,
      plan_nombre     VARCHAR(100) DEFAULT 'Sin plan',
      likes_disponibles INTEGER DEFAULT 0,
      envios_por_dia    INTEGER DEFAULT 0,
      envios_hoy        INTEGER DEFAULT 0,
      fecha_ultimo_envio DATE,
      plan_vence        TIMESTAMP,
      creado_en         TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS codigos (
      id          SERIAL PRIMARY KEY,
      codigo      VARCHAR(20) UNIQUE NOT NULL,
      dias        INTEGER NOT NULL,
      likes       INTEGER NOT NULL,
      envios_dia  INTEGER NOT NULL,
      usado       BOOLEAN DEFAULT false,
      usado_por   VARCHAR(20),
      usado_en    TIMESTAMP,
      creado_en   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS historial (
      id         SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      ff_uid     VARCHAR(30) NOT NULL,
      region     VARCHAR(10) NOT NULL,
      fecha      TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Base de datos lista');
}

// ── Helpers ───────────────────────────────────────────────────
function genUID() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'BS-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function genCodigo(custom) {
  if (custom && custom.trim()) return custom.trim().toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'bs_secret_2026');
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Acceso denegado' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ════════════════════════════════════════════════════════════════
//  RUTAS DE USUARIOS
// ════════════════════════════════════════════════════════════════

// ── Registro ──────────────────────────────────────────────────
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
    if (existe.rows.length) return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });

    const hash = await bcrypt.hash(password, 10);
    let uid;
    // Asegurarse de que el UID sea único
    let intentos = 0;
    do {
      uid = genUID();
      const chk = await pool.query('SELECT id FROM usuarios WHERE uid=$1', [uid]);
      if (!chk.rows.length) break;
    } while (++intentos < 20);

    const result = await pool.query(
      `INSERT INTO usuarios (uid, username, password, contact)
       VALUES ($1,$2,$3,$4) RETURNING id, uid, username, contact, plan_activo, plan_nombre,
       likes_disponibles, envios_por_dia, plan_vence, creado_en`,
      [uid, username, hash, contact]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, uid: user.uid, username: user.username },
      process.env.JWT_SECRET || 'bs_secret_2026',
      { expiresIn: '30d' }
    );

    res.json({ ok: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Login ─────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Ingresa usuario y contraseña' });

    const result = await pool.query('SELECT * FROM usuarios WHERE LOWER(username)=LOWER($1)', [username]);
    if (!result.rows.length) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

    const token = jwt.sign(
      { id: user.id, uid: user.uid, username: user.username },
      process.env.JWT_SECRET || 'bs_secret_2026',
      { expiresIn: '30d' }
    );

    const { password: _, ...userSafe } = user;
    res.json({ ok: true, token, user: userSafe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Recuperar contraseña (muestra al usuario su pass) ─────────
app.post('/api/recuperar', async (req, res) => {
  try {
    const { contact } = req.body;
    const result = await pool.query('SELECT * FROM usuarios WHERE contact=$1', [contact]);
    if (!result.rows.length)
      return res.status(404).json({ error: 'No se encontró ninguna cuenta con ese contacto' });
    // En producción enviarías email/SMS, aquí indicamos que se contacte al admin
    res.json({ ok: true, message: 'Contacta al administrador con tu ID de usuario para recuperar tu contraseña.' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Perfil del usuario ─────────────────────────────────────────
app.get('/api/perfil', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Reset envíos si es un nuevo día
    await pool.query(
      `UPDATE usuarios SET envios_hoy=0, fecha_ultimo_envio=$1
       WHERE id=$2 AND (fecha_ultimo_envio IS NULL OR fecha_ultimo_envio < $1)`,
      [today, req.user.id]
    );

    const result = await pool.query(
      `SELECT id, uid, username, contact, plan_activo, plan_nombre,
       likes_disponibles, envios_por_dia, envios_hoy, plan_vence, creado_en
       FROM usuarios WHERE id=$1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar si el plan venció
    const u = result.rows[0];
    if (u.plan_activo && u.plan_vence && new Date(u.plan_vence) < new Date()) {
      await pool.query('UPDATE usuarios SET plan_activo=false WHERE id=$1', [u.id]);
      u.plan_activo = false;
    }

    // Historial
    const hist = await pool.query(
      'SELECT ff_uid, region, fecha FROM historial WHERE usuario_id=$1 ORDER BY fecha DESC LIMIT 30',
      [req.user.id]
    );

    res.json({ ok: true, user: u, historial: hist.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Canjear código ─────────────────────────────────────────────
app.post('/api/canjear', authMiddleware, async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Ingresa un código' });

    const codResult = await pool.query('SELECT * FROM codigos WHERE codigo=$1', [codigo.toUpperCase()]);
    if (!codResult.rows.length) return res.status(400).json({ error: 'Código inválido o inexistente' });

    const cod = codResult.rows[0];
    if (cod.usado) return res.status(400).json({ error: 'Este código ya fue utilizado' });

    const user = await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.user.id]);
    const u = user.rows[0];

    const ahora = new Date();
    const vence = new Date(ahora.getTime() + cod.dias * 86400000);

    // Sumar likes al saldo existente
    await pool.query(
      `UPDATE usuarios SET
        plan_activo=true,
        plan_nombre=$1,
        likes_disponibles=likes_disponibles+$2,
        envios_por_dia=$3,
        plan_vence=$4
       WHERE id=$5`,
      [`Plan ${cod.dias} días`, cod.likes, cod.envios_dia, vence.toISOString(), req.user.id]
    );

    await pool.query(
      'UPDATE codigos SET usado=true, usado_por=$1, usado_en=NOW() WHERE codigo=$2',
      [u.uid, cod.codigo]
    );

    res.json({
      ok: true,
      message: `✅ Plan activado: ${cod.likes} likes · ${cod.dias} días · ${cod.envios_dia} envíos/día`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Enviar likes ───────────────────────────────────────────────
app.post('/api/enviar-likes', authMiddleware, async (req, res) => {
  try {
    const { ff_uid, region } = req.body;
    if (!ff_uid || !region) return res.status(400).json({ error: 'Completa todos los campos' });
    if (!/^\d+$/.test(ff_uid)) return res.status(400).json({ error: 'El UID solo debe contener números' });

    const today = new Date().toISOString().slice(0, 10);

    // Reset diario
    await pool.query(
      `UPDATE usuarios SET envios_hoy=0, fecha_ultimo_envio=$1
       WHERE id=$2 AND (fecha_ultimo_envio IS NULL OR fecha_ultimo_envio < $1)`,
      [today, req.user.id]
    );

    const result = await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.user.id]);
    const u = result.rows[0];

    if (!u.plan_activo) return res.status(400).json({ error: 'Necesitas un plan activo para enviar likes' });
    if (u.plan_vence && new Date(u.plan_vence) < new Date()) {
      await pool.query('UPDATE usuarios SET plan_activo=false WHERE id=$1', [u.id]);
      return res.status(400).json({ error: 'Tu plan ha vencido. Canjea un nuevo código' });
    }
    if (u.envios_hoy >= u.envios_por_dia)
      return res.status(400).json({ error: `Límite diario alcanzado (${u.envios_por_dia} envíos/día). Vuelve mañana` });
    if (u.likes_disponibles <= 0)
      return res.status(400).json({ error: 'No tienes likes disponibles' });

    // Aquí iría la llamada a la API real de Free Fire (variable de entorno FF_API_KEY)
    // Por ahora simulamos el envío exitoso
    await pool.query(
      `UPDATE usuarios SET
        envios_hoy = envios_hoy + 1,
        likes_disponibles = likes_disponibles - 1,
        fecha_ultimo_envio = $1
       WHERE id=$2`,
      [today, req.user.id]
    );

    await pool.query(
      'INSERT INTO historial (usuario_id, ff_uid, region) VALUES ($1,$2,$3)',
      [req.user.id, ff_uid, region]
    );

    res.json({ ok: true, message: `✅ Likes enviados a UID ${ff_uid} (${region}). Aparecerán en minutos.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Cambiar contraseña ─────────────────────────────────────────
app.post('/api/cambiar-pass', authMiddleware, async (req, res) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva)
      return res.status(400).json({ error: 'Completa ambos campos' });
    if (password_nueva.length < 6)
      return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 6 caracteres' });

    const result = await pool.query('SELECT password FROM usuarios WHERE id=$1', [req.user.id]);
    const match = await bcrypt.compare(password_actual, result.rows[0].password);
    if (!match) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });

    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query('UPDATE usuarios SET password=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true, message: '✅ Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
//  RUTAS DE ADMINISTRADOR
// ════════════════════════════════════════════════════════════════

// ── Login admin ───────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'boostspeed2026';
  if (username !== adminUser || password !== adminPass)
    return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign(
    { isAdmin: true, username },
    process.env.JWT_SECRET || 'bs_secret_2026',
    { expiresIn: '12h' }
  );
  res.json({ ok: true, token });
});

// ── Stats del dashboard admin ─────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const [totalU, totalC, usadosC, activosP, recentU] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM usuarios'),
      pool.query('SELECT COUNT(*) FROM codigos'),
      pool.query('SELECT COUNT(*) FROM codigos WHERE usado=true'),
      pool.query('SELECT COUNT(*) FROM usuarios WHERE plan_activo=true'),
      pool.query(`SELECT id, uid, username, contact, plan_activo, plan_nombre, likes_disponibles, creado_en
                  FROM usuarios ORDER BY creado_en DESC LIMIT 10`),
    ]);
    res.json({
      ok: true,
      totalUsuarios:  parseInt(totalU.rows[0].count),
      totalCodigos:   parseInt(totalC.rows[0].count),
      codigosUsados:  parseInt(usadosC.rows[0].count),
      planesActivos:  parseInt(activosP.rows[0].count),
      usuariosRecientes: recentU.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Crear código ──────────────────────────────────────────────
app.post('/api/admin/codigos', adminMiddleware, async (req, res) => {
  try {
    const { dias, likes, envios_dia, custom } = req.body;
    if (!dias || !likes || !envios_dia)
      return res.status(400).json({ error: 'Completa todos los campos' });
    if (dias < 1 || likes < 1 || envios_dia < 1)
      return res.status(400).json({ error: 'Los valores deben ser mayores a 0' });

    let codigo;
    let intentos = 0;
    do {
      codigo = genCodigo(intentos === 0 ? custom : '');
      const chk = await pool.query('SELECT id FROM codigos WHERE codigo=$1', [codigo]);
      if (!chk.rows.length) break;
    } while (++intentos < 20);

    const result = await pool.query(
      'INSERT INTO codigos (codigo, dias, likes, envios_dia) VALUES ($1,$2,$3,$4) RETURNING *',
      [codigo, dias, likes, envios_dia]
    );
    res.json({ ok: true, codigo: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código ya existe' });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Listar códigos ────────────────────────────────────────────
app.get('/api/admin/codigos', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM codigos ORDER BY creado_en DESC');
    res.json({ ok: true, codigos: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Eliminar código ───────────────────────────────────────────
app.delete('/api/admin/codigos/:codigo', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM codigos WHERE codigo=$1', [req.params.codigo]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Listar todos los usuarios ─────────────────────────────────
app.get('/api/admin/usuarios', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, uid, username, contact, plan_activo, plan_nombre,
       likes_disponibles, envios_por_dia, envios_hoy, plan_vence, creado_en
       FROM usuarios ORDER BY creado_en DESC`
    );
    res.json({ ok: true, usuarios: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Buscar usuario ────────────────────────────────────────────
app.get('/api/admin/usuarios/buscar', adminMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const result = await pool.query(
      `SELECT id, uid, username, contact, plan_activo, plan_nombre,
       likes_disponibles, envios_por_dia, envios_hoy, plan_vence, creado_en
       FROM usuarios
       WHERE uid ILIKE $1 OR LOWER(username) ILIKE LOWER($1)
       LIMIT 10`,
      [`%${q}%`]
    );
    res.json({ ok: true, usuarios: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Editar usuario ────────────────────────────────────────────
app.put('/api/admin/usuarios/:id', adminMiddleware, async (req, res) => {
  try {
    const { likes_disponibles, dias_adicionales, envios_por_dia, plan_activo } = req.body;
    const userId = req.params.id;

    let venceSQL = '';
    const params = [];
    let idx = 1;

    params.push(likes_disponibles); const li = idx++;
    params.push(envios_por_dia);    const ep = idx++;
    params.push(plan_activo);       const pa = idx++;

    if (plan_activo && dias_adicionales > 0) {
      const nuevaFecha = new Date(Date.now() + dias_adicionales * 86400000).toISOString();
      params.push(nuevaFecha); venceSQL = `, plan_vence=$${idx++}`;
      params.push(`Plan ${dias_adicionales} días (Admin)`);
      venceSQL += `, plan_nombre=$${idx++}`;
    } else if (!plan_activo) {
      params.push(null); venceSQL = `, plan_vence=$${idx++}`;
    }

    params.push(userId);
    await pool.query(
      `UPDATE usuarios SET likes_disponibles=$${li}, envios_por_dia=$${ep}, plan_activo=$${pa}${venceSQL} WHERE id=$${idx}`,
      params
    );

    const updated = await pool.query(
      `SELECT id, uid, username, contact, plan_activo, plan_nombre,
       likes_disponibles, envios_por_dia, envios_hoy, plan_vence, creado_en
       FROM usuarios WHERE id=$1`,
      [userId]
    );
    res.json({ ok: true, usuario: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Eliminar usuario ──────────────────────────────────────────
app.delete('/api/admin/usuarios/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Historial de un usuario ───────────────────────────────────
app.get('/api/admin/usuarios/:id/historial', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT ff_uid, region, fecha FROM historial WHERE usuario_id=$1 ORDER BY fecha DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ ok: true, historial: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Ruta catch-all: servir el index.html para SPA ─────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// ── Iniciar ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 BoostSpeed corriendo en puerto ${PORT}`));
}).catch(err => {
  console.error('❌ Error conectando a la base de datos:', err.message);
  process.exit(1);
});
