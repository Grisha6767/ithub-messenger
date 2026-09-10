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

const PORT = 3000;

// ===== СТАТИКА =====
app.use(express.static('public'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ===== ЗАГРУЗКА ФАЙЛОВ =====
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Отдельный multer для аватарок
const avatarStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, 'avatar_' + Date.now() + '_' + file.originalname);
  }
});
const uploadAvatar = multer({ storage: avatarStorage });

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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ===== ФУНКЦИИ ДЛЯ WHITELIST =====
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
  const user = whitelist.users.find(u => u.login === login && u.password === password);

  if (user) {
    const { password, ...userWithoutPass } = user;
    res.json({ success: true, user: userWithoutPass });
  } else {
    res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }
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

  // Убираем пароли
  contacts = contacts.map(({ password, ...rest }) => rest);

  res.json(contacts);
});

// ===== ИСТОРИЯ СООБЩЕНИЙ =====
app.get('/messages', (req, res) => {
  const { from, to } = req.query;
  db.all(
    `SELECT * FROM messages WHERE 
     (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
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

// ===== ИЗМЕНЕНИЕ СООБЩЕНИЯ =====
app.post('/edit-message', (req, res) => {
  const { id, text, from } = req.body;

  if (!id || !text) {
    return res.status(400).json({ success: false, error: 'Не хватает данных' });
  }

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
  res.json({ filename: req.file.filename });
});

// ===== ЗАГРУЗКА АВАТАРКИ =====
app.post('/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });

  const { filename } = req.file;
  const userId = parseInt(req.body.userId);

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

// ===== WEBSOCKET + ОТСЛЕЖИВАНИЕ ОНЛАЙНА =====
const onlineUsers = new Map(); // userId -> socket.id

io.on('connection', (socket) => {
  console.log('Новый пользователь подключился');

  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    console.log(`Пользователь ${userId} присоединился`);

    // Рассылаем всем обновлённый список онлайн
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  socket.on('message', (data) => {
    const { from, to, text, file, voice, tempId } = data;

    db.run(
      `INSERT INTO messages (from_user, to_user, text, file, voice) VALUES (?, ?, ?, ?, ?)`,
      [from, to, text || null, file || null, voice || null],
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
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      console.log(`Пользователь ${socket.userId} отключился`);
      io.emit('online-users', Array.from(onlineUsers.keys()));
    }
  });
});

// ===== ЗАПУСК =====
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});