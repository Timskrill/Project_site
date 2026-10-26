const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const JWT_SECRET = 'super_secret_key_dlya_uchebnogo_proekta';

const pool = new Pool({
  user: 'postgres',
  password: 'postgres',  // ВАЖНО: замени на свой пароль!
  host: 'localhost',
  port: 5432,
  database: 'project'
});

function getUserIdFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const userResult = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
    if (userResult.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = userResult.rows[0];
    if (password !== user.password_hash) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/resources', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM resources WHERE is_active = TRUE ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const client = await pool.connect();
  try {
    const user = getUserIdFromToken(req);
    if (!user) return res.status(401).json({ error: 'Необходимо войти' });

    const idempotencyKey = req.headers['idempotency-key'];
    const { resource_id, starts_at, ends_at, purpose } = req.body;

    await client.query('BEGIN');

    if (idempotencyKey) {
      const keyCheck = await client.query(
        'SELECT booking_id FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [user.id, idempotencyKey]
      );
      if (keyCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        const existingBooking = await client.query('SELECT * FROM bookings WHERE id = $1', [keyCheck.rows[0].booking_id]);
        return res.status(200).json(existingBooking.rows[0]);
      }
    }

    const result = await client.query(
      `INSERT INTO bookings (resource_id, owner_id, starts_at, ends_at, purpose, status) 
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [resource_id, user.id, starts_at, ends_at, purpose]
    );

    const newBooking = result.rows[0];

    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (user_id, key, request_fingerprint, booking_id) 
         VALUES ($1, $2, $3, $4)`,
        [user.id, idempotencyKey, JSON.stringify(req.body), newBooking.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(newBooking);

  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      return res.status(409).json({ error: 'Ресурс уже занят в выбранное время' });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Конфликт ключа идемпотентности' });
    }
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/bookings/my', async (req, res) => {
  try {
    const user = getUserIdFromToken(req);
    if (!user) return res.status(401).json({ error: 'Необходимо войти' });
    const result = await pool.query(
      `SELECT b.*, r.name as resource_name FROM bookings b
       JOIN resources r ON b.resource_id = r.id
       WHERE b.owner_id = $1 ORDER BY b.starts_at DESC`, [user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const user = getUserIdFromToken(req);
    if (!user) return res.status(401).json({ error: 'Необходимо войти' });
    const bookingId = req.params.id;
    const bookingCheck = await pool.query(
      'SELECT * FROM bookings WHERE id = $1 AND owner_id = $2 AND status = $3',
      [bookingId, user.id, 'active']
    );
    if (bookingCheck.rows.length === 0) return res.status(404).json({ error: 'Бронь не найдена' });
    await pool.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1 WHERE id = $2`,
      [user.id, bookingId]
    );
    res.json({ message: 'Бронь отменена' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/bookings', async (req, res) => {
  try {
    const user = getUserIdFromToken(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
    const result = await pool.query(
      `SELECT b.*, r.name as resource_name, u.name as owner_name FROM bookings b
       JOIN resources r ON b.resource_id = r.id JOIN users u ON b.owner_id = u.id ORDER BY b.starts_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/bookings/:id/cancel', async (req, res) => {
  try {
    const user = getUserIdFromToken(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Необходимо указать причину' });
    const bookingId = req.params.id;
    const bookingCheck = await pool.query('SELECT * FROM bookings WHERE id = $1 AND status = $2', [bookingId, 'active']);
    if (bookingCheck.rows.length === 0) return res.status(404).json({ error: 'Активная бронь не найдена' });
    await pool.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, cancel_reason = $2 WHERE id = $3`,
      [user.id, reason, bookingId]
    );
    res.json({ message: 'Отменено админом' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.listen(3000, () => {
  console.log('Сервер запущен! Открой в браузере: http://localhost:3000');
});