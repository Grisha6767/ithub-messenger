const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// ===== CORS для мобильных =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===== СТАТИКА =====
app.use(express.static('public'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ===== ЗАГРУЗКА ФАЙЛОВ =====
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ===== ЗАГРУЗКА АВАТАРОК =====
const avatarStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, 'avatar_' + Date.now() + '_' + safeName);
  }
});
const uploadAvatar = multer({ 
  storage: avatarStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('database.db', (err) => {
  if (err) console.error('Ошибка БД:', err);
  else console.log('SQLite подключена');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER,
    to_user INTEGER,
    text TEXT,
    file TEXT,
    voice TEXT,
    edited INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    reply_to INTEGER DEFAULT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ===== WHITELIST =====
function readWhitelist() {
  return JSON.parse(fs.readFileSync('./whitelist.json', 'utf8'));
}

function saveWhitelist(data) {
  fs.writeFileSync('./whitelist.json', JSON.stringify(data, null, 2), 'utf8');
}

// ===== АВТОРИЗАЦИЯ =====
app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const whitelist = readWhitelist();
  const user = whitelist.users.find(u => u.login === login);

  if (!user) {
    return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }

  // Простое сравнение пароля (без bcrypt для простоты)
  if (user.password !== password) {
    return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }

  // Обновляем lastSeen
  user.lastSeen = new Date().toISOString();
  saveWhitelist(whitelist);

  const { password: _, ...userWithoutPass } = user;
  res.json({ success: true, user: userWithoutPass });
});

// ===== КОНТАКТЫ =====
app.get('/contacts', (req, res) => {
  const userId = parseInt(req.query.userId);
  const whitelist = readWhitelist();
  const user = whitelist.users.find(u => u.id === userId);

  if (!user) return res.status(404).json([]);

  let contacts = [];
  if (user.role === 'teacher') {
    contacts = whitelist.users.filter(u =>
      u.role === 'student' && user.groups.includes(u.group)
    );
  } else {
    contacts = whitelist.users.filter(u =>
      u.role === 'teacher' && u.groups.includes(user.group)
    );
  }

  contacts = contacts.map(({ password, ...rest }) => rest);
  res.json(contacts);
});

// ===== ИСТОРИЯ СООБЩЕНИЙ =====
app.get('/messages', (req, res) => {
  const { from, to } = req.query;

  db.all(
    `SELECT m.*, 
       (SELECT text FROM messages WHERE id = m.reply_to) AS reply_text,
       (SELECT from_user FROM messages WHERE id = m.reply_to) AS reply_from
     FROM messages m
     WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
     ORDER BY timestamp ASC`,
    [from, to, to, from],
    (err, rows) => {
      if (err) {
        console.error('Ошибка загрузки сообщений:', err);
        res.status(500).json([]);
      } else {
        res.json(rows);
      }
    }
  );
});

// ===== ОТМЕТИТЬ КАК ПРОЧИТАННЫЕ =====
app.post('/mark-read', (req, res) => {
  const { from, to } = req.body;
  db.run(
    `UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?`,
    [from, to],
    function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`user_${from}`).emit('messages-read', { by: to });
      res.json({ success: true });
    }
  );
});

// ===== ИЗМЕНЕНИЕ СООБЩЕНИЯ =====
app.post('/edit-message', (req, res) => {
  const { id, text, from } = req.body;
  if (!id || !text) return res.status(400).json({ success: false, error: 'Не хватает данных' });

  db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!row) return res.status(404).json({ success: false, error: 'Сообщение не найдено' });
    if (row.from_user !== from) return res.status(403).json({ success: false, error: 'Нет прав' });

    db.run(
      `UPDATE messages SET text = ?, edited = 1 WHERE id = ?`,
      [text, id],
      function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        io.to(`user_${row.to_user}`).emit('message-edited', { id, text });
        io.to(`user_${row.from_user}`).emit('message-edited', { id, text });
        res.json({ success: true });
      }
    );
  });
});

// ===== УДАЛЕНИЕ СООБЩЕНИЯ =====
app.post('/delete-message', (req, res) => {
  const { id, from } = req.body;
  if (!id) return res.status(400).json({ success: false, error: 'Не хватает данных' });

  db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!row) return res.status(404).json({ success: false, error: 'Сообщение не найдено' });
    if (row.from_user !== from) return res.status(403).json({ success: false, error: 'Нет прав' });

    db.run(`DELETE FROM messages WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      io.to(`user_${row.to_user}`).emit('message-deleted', { id });
      io.to(`user_${row.from_user}`).emit('message-deleted', { id });
      res.json({ success: true });
    });
  });
});

// ===== ЗАГРУЗКА ФАЙЛОВ =====
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Файл не получен' });
  console.log('Загружен файл:', req.file.filename, req.file.size, 'байт');
  res.json({ success: true, filename: req.file.filename });
});

// ===== АВАТАРКА =====
app.post('/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
  console.log('=== Загрузка аватарки ===');
  console.log('File:', req.file ? req.file.filename : 'НЕТ');
  console.log('Body:', req.body);

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Файл не получен' });
  }

  const { filename } = req.file;
  const userId = parseInt(req.body.userId);

  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId не передан' });
  }

  const data = readWhitelist();
  const user = data.users.find(u => u.id === userId);

  if (user) {
    user.avatar = filename;
    saveWhitelist(data);
    io.emit('avatar-updated', { userId, avatar: filename });
    res.json({ success: true, filename });
  } else {
    res.status(404).json({ success: false, error: 'Пользователь не найден' });
  }
});

// ===== СМЕНА ПАРОЛЯ =====
app.post('/change-password', (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;
  if (!userId || !oldPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Не хватает данных' });
  }

  const data = readWhitelist();
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
  if (user.password !== oldPassword) return res.status(403).json({ success: false, error: 'Неверный текущий пароль' });
  if (newPassword.length < 4) return res.status(400).json({ success: false, error: 'Пароль слишком короткий' });

  user.password = newPassword;
  saveWhitelist(data);
  res.json({ success: true });
});

// ===== WEBSOCKET =====
const onlineUsers = new Map();
const offlineTimers = new Map();

function broadcastOnlineUsers() {
  const list = [];
  onlineUsers.forEach((data, userId) => {
    list.push({
      id: userId,
      status: data.status,
      lastSeen: data.lastSeen
    });
  });
  io.emit('online-users', list);
}

io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
    socket.userId = userId;

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, { sockets: new Set(), status: 'online', lastSeen: new Date() });
    }
    onlineUsers.get(userId).sockets.add(socket.id);
    onlineUsers.get(userId).status = 'online';

    if (offlineTimers.has(userId)) {
      clearTimeout(offlineTimers.get(userId));
      offlineTimers.delete(userId);
    }

    broadcastOnlineUsers();
    console.log(`Пользователь ${userId} в сети`);
  });

  socket.on('away', (userId) => {
    if (onlineUsers.has(userId)) {
      onlineUsers.get(userId).status = 'away';
      broadcastOnlineUsers();
    }
  });

  socket.on('back', (userId) => {
    if (onlineUsers.has(userId)) {
      onlineUsers.get(userId).status = 'online';
      broadcastOnlineUsers();
    }
  });

  socket.on('typing', (data) => {
    const { from, to } = data;
    io.to(`user_${to}`).emit('user-typing', { from });
  });

  socket.on('stop-typing', (data) => {
    const { from, to } = data;
    io.to(`user_${to}`).emit('user-stop-typing', { from });
  });

  socket.on('mark-read', (data) => {
    const { from, to } = data;
    db.run(
      `UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?`,
      [from, to],
      function(err) {
        if (!err) {
          io.to(`user_${from}`).emit('messages-read', { by: to });
        }
      }
    );
  });

  socket.on('message', (data) => {
    const { from, to, text, file, voice, tempId, replyTo } = data;

    db.run(
      `INSERT INTO messages (from_user, to_user, text, file, voice, reply_to) VALUES (?, ?, ?, ?, ?, ?)`,
      [from, to, text || null, file || null, voice || null, replyTo || null],
      function(err) {
        if (err) {
          console.error('Ошибка сохранения:', err);
        } else {
          const message = {
            id: this.lastID,
            from_user: from,
            to_user: to,
            text: text || '',
            file: file || null,
            voice: voice || null,
            reply_to: replyTo || null,
            read: 0,
            tempId: tempId || null,
            timestamp: new Date()
          };
          io.to(`user_${to}`).emit('message', message);
          io.to(`user_${from}`).emit('message', message);
        }
      }
    );
  });

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (!userId) return;

    const data = onlineUsers.get(userId);
    if (data) {
      data.sockets.delete(socket.id);

      if (data.sockets.size === 0) {
        data.status = 'away';
        data.lastSeen = new Date();
        broadcastOnlineUsers();

        const t = setTimeout(() => {
          onlineUsers.delete(userId);
          offlineTimers.delete(userId);
          broadcastOnlineUsers();
          console.log(`Пользователь ${userId} ушёл в офлайн`);
        }, 2 * 60 * 1000);
        offlineTimers.set(userId, t);
      }
    }
  });
});

// ===== ЗАПУСК =====
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});