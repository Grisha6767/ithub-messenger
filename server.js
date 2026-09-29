const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// ===== MULTER =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const safeName = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop() || 'jpg';
    cb(null, 'avatar_' + Date.now() + '.' + ext.replace(/[^a-zA-Z0-9]/g, ''));
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Только изображения'), false);
    cb(null, true);
  }
});

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('database.db', (err) => {
  if (err) console.error('Ошибка БД:', err);
  else console.log('SQLite подключена');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER, to_user INTEGER,
    text TEXT, file TEXT, voice TEXT,
    edited INTEGER DEFAULT 0, read INTEGER DEFAULT 0,
    reply_to INTEGER DEFAULT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT,
    creator_id INTEGER, avatar TEXT,
    pinned_message_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER, user_id INTEGER,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER, name TEXT NOT NULL,
    creator_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER, topic_id INTEGER DEFAULT NULL,
    from_user INTEGER, text TEXT, file TEXT, voice TEXT,
    edited INTEGER DEFAULT 0,
    reply_to INTEGER DEFAULT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // НОВОЕ: Реакции
  db.run(`CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER, user_id INTEGER,
    emoji TEXT,
    is_group INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, emoji, is_group)
  )`);
});

// Миграция: добавить pinned_message_id если БД старая
db.all(`PRAGMA table_info(groups)`, (err, cols) => {
  if (err) return;
  const hasPinned = cols.some(c => c.name === 'pinned_message_id');
  if (!hasPinned) {
    db.run(`ALTER TABLE groups ADD COLUMN pinned_message_id INTEGER DEFAULT NULL`);
    console.log('Миграция: добавлено поле pinned_message_id');
  }
});

function readWhitelist() {
  try { return JSON.parse(fs.readFileSync('./whitelist.json', 'utf8')); }
  catch (err) { console.error('Ошибка whitelist:', err); return { users: [] }; }
}
function saveWhitelist(data) {
  try { fs.writeFileSync('./whitelist.json', JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (err) { console.error('Ошибка whitelist:', err); return false; }
}

// ===== АВТОРИЗАЦИЯ =====
app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const whitelist = readWhitelist();
  const user = whitelist.users.find(u => u.login === login);
  if (!user) return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  if (user.password !== password) return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });

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
    contacts = whitelist.users.filter(u => u.role === 'student' && user.groups.includes(u.group));
  } else {
    contacts = whitelist.users.filter(u => u.role === 'teacher' && u.groups.includes(user.group));
  }
  contacts = contacts.map(({ password, ...rest }) => rest);
  res.json(contacts);
});

// ===== ЛИЧНЫЕ СООБЩЕНИЯ =====
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
      if (err) return res.status(500).json([]);
      // Подгружаем реакции для каждого
      const ids = rows.map(r => r.id);
      if (!ids.length) return res.json(rows);

      db.all(`SELECT * FROM message_reactions WHERE is_group = 0 AND message_id IN (${ids.join(',')})`, (err, reactions) => {
        if (!err && reactions) {
          rows.forEach(r => {
            r.reactions = reactions.filter(x => x.message_id === r.id).map(x => ({ emoji: x.emoji, user_id: x.user_id }));
          });
        }
        res.json(rows);
      });
    }
  );
});

app.post('/edit-message', (req, res) => {
  const { id, text, from } = req.body;
  if (!id || !text) return res.status(400).json({ success: false });
  db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false });
    if (row.from_user !== from) return res.status(403).json({ success: false });
    db.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = ?`, [text, id], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`user_${row.to_user}`).emit('message-edited', { id: parseInt(id), text });
      io.to(`user_${row.from_user}`).emit('message-edited', { id: parseInt(id), text });
      res.json({ success: true });
    });
  });
});

app.post('/delete-message', (req, res) => {
  const { id, from } = req.body;
  if (!id) return res.status(400).json({ success: false });
  db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false });
    if (row.from_user !== from) return res.status(403).json({ success: false });
    db.run(`DELETE FROM messages WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`user_${row.to_user}`).emit('message-deleted', { id: parseInt(id) });
      io.to(`user_${row.from_user}`).emit('message-deleted', { id: parseInt(id) });
      res.json({ success: true });
    });
  });
});

app.post('/mark-read', (req, res) => {
  const { from, to } = req.body;
  db.run(`UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?`, [from, to], function(err) {
    if (err) return res.status(500).json({ success: false });
    io.to(`user_${from}`).emit('messages-read', { by: parseInt(to) });
    res.json({ success: true });
  });
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  res.json({ success: true, filename: req.file.filename });
});

app.post('/upload-avatar', (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false });
    const { filename } = req.file;
    const userId = parseInt(req.body.userId);
    const data = readWhitelist();
    const user = data.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success: false });
    user.avatar = filename;
    saveWhitelist(data);
    io.emit('avatar-updated', { userId, avatar: filename });
    res.json({ success: true, filename });
  });
});

app.post('/change-password', (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;
  if (!userId || !oldPassword || !newPassword) return res.status(400).json({ success: false });
  const data = readWhitelist();
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ success: false });
  if (user.password !== oldPassword) return res.status(403).json({ success: false, error: 'Неверный пароль' });
  if (newPassword.length < 4) return res.status(400).json({ success: false });
  user.password = newPassword;
  saveWhitelist(data);
  res.json({ success: true });
});

// ==========================================
// ============ ГРУППЫ ======================
// ==========================================

app.post('/groups/create', (req, res) => {
  const { name, description, creatorId, memberIds } = req.body;
  if (!name || !creatorId) return res.status(400).json({ success: false });

  const whitelist = readWhitelist();
  const creator = whitelist.users.find(u => u.id === creatorId);
  if (!creator || creator.role !== 'teacher') return res.status(403).json({ success: false });

  db.run(
    `INSERT INTO groups (name, description, creator_id) VALUES (?, ?, ?)`,
    [name, description || '', creatorId],
    function(err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      const groupId = this.lastID;
      db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')`, [groupId, creatorId]);
      if (memberIds && memberIds.length) {
        memberIds.forEach(uid => db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`, [groupId, uid]));
      }
      db.run(`INSERT INTO group_topics (group_id, name, creator_id) VALUES (?, 'Общий чат', ?)`, [groupId, creatorId]);
      const allMembers = [creatorId, ...(memberIds || [])];
      allMembers.forEach(uid => io.to(`user_${uid}`).emit('group-created', { groupId, name }));
      res.json({ success: true, groupId });
    }
  );
});

app.get('/groups', (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return res.status(400).json([]);
  db.all(
    `SELECT g.*, 
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
       (SELECT role FROM group_members WHERE group_id = g.id AND user_id = ?) AS my_role
     FROM groups g
     INNER JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ?
     ORDER BY g.created_at DESC`,
    [userId, userId],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows);
    }
  );
});

// НОВОЕ: обновление группы (имя, описание, аватар, закреп)
app.post('/groups/:id/update', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { name, description, avatar, requesterId, pinnedMessageId } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false, error: 'Только создатель' });

    const fields = [];
    const params = [];
    if (typeof name === 'string' && name.trim()) { fields.push('name = ?'); params.push(name.trim()); }
    if (typeof description === 'string') { fields.push('description = ?'); params.push(description); }
    if (typeof avatar === 'string') { fields.push('avatar = ?'); params.push(avatar); }
    if (typeof pinnedMessageId !== 'undefined') { fields.push('pinned_message_id = ?'); params.push(pinnedMessageId); }

    if (!fields.length) return res.json({ success: true });
    params.push(groupId);

    db.run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, params, function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`group_${groupId}`).emit('group-updated', { groupId });
      res.json({ success: true });
    });
  });
});

// НОВОЕ: загрузка аватарки группы
app.post('/groups/:id/upload-avatar', (req, res) => {
  const groupId = parseInt(req.params.id);
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false });
    const requesterId = parseInt(req.body.requesterId);

    db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
      if (err || !group) return res.status(404).json({ success: false });
      if (group.creator_id !== requesterId) return res.status(403).json({ success: false });

      db.run(`UPDATE groups SET avatar = ? WHERE id = ?`, [req.file.filename, groupId], function(err) {
        if (err) return res.status(500).json({ success: false });
        io.to(`group_${groupId}`).emit('group-updated', { groupId });
        res.json({ success: true, filename: req.file.filename });
      });
    });
  });
});

// НОВОЕ: удаление группы
app.post('/groups/:id/delete', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { requesterId } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false });

    db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
      db.run(`DELETE FROM groups WHERE id = ?`, [groupId]);
      db.run(`DELETE FROM group_members WHERE group_id = ?`, [groupId]);
      db.run(`DELETE FROM group_topics WHERE group_id = ?`, [groupId]);
      db.run(`DELETE FROM group_messages WHERE group_id = ?`, [groupId]);

      if (members) members.forEach(m => io.to(`user_${m.user_id}`).emit('group-deleted', { groupId }));
      res.json({ success: true });
    });
  });
});

app.get('/groups/:id/members', (req, res) => {
  const groupId = parseInt(req.params.id);
  const whitelist = readWhitelist();
  db.all(`SELECT * FROM group_members WHERE group_id = ?`, [groupId], (err, rows) => {
    if (err) return res.status(500).json([]);
    const members = rows.map(row => {
      const user = whitelist.users.find(u => u.id === row.user_id);
      if (!user) return null;
      const { password, ...rest } = user;
      return { ...rest, group_role: row.role };
    }).filter(Boolean);
    res.json(members);
  });
});

app.post('/groups/:id/add-member', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { userId, requesterId } = req.body;
  if (!userId || !requesterId) return res.status(400).json({ success: false });

  db.get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, requesterId], (err, requester) => {
    if (err || !requester) return res.status(403).json({ success: false });
    if (requester.role !== 'admin') return res.status(403).json({ success: false });
    db.get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, userId], (err, existing) => {
      if (existing) return res.status(400).json({ success: false });
      db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`, [groupId, userId], function(err) {
        if (err) return res.status(500).json({ success: false });
        io.to(`user_${userId}`).emit('group-added', { groupId });
        io.to(`group_${groupId}`).emit('group-member-added', { groupId, userId });
        res.json({ success: true });
      });
    });
  });
});

app.post('/groups/:id/remove-member', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { userId, requesterId } = req.body;
  if (!userId || !requesterId) return res.status(400).json({ success: false });

  db.get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, requesterId], (err, requester) => {
    if (err || !requester || requester.role !== 'admin') return res.status(403).json({ success: false });
    db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
      if (group.creator_id === userId) return res.status(403).json({ success: false, error: 'Нельзя удалить создателя' });
      db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, userId], function(err) {
        if (err) return res.status(500).json({ success: false });
        io.to(`user_${userId}`).emit('group-removed', { groupId });
        io.to(`group_${groupId}`).emit('group-member-removed', { groupId, userId });
        res.json({ success: true });
      });
    });
  });
});

// ===== ВЕТКИ =====
app.post('/groups/:id/topics/create', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { name, creatorId } = req.body;
  if (!name || !creatorId) return res.status(400).json({ success: false });

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== creatorId) return res.status(403).json({ success: false });
    db.run(`INSERT INTO group_topics (group_id, name, creator_id) VALUES (?, ?, ?)`, [groupId, name, creatorId], function(err) {
      if (err) return res.status(500).json({ success: false });
      const topicId = this.lastID;
      io.to(`group_${groupId}`).emit('topic-created', { groupId, topicId, name });
      res.json({ success: true, topicId });
    });
  });
});

app.get('/groups/:id/topics', (req, res) => {
  const groupId = parseInt(req.params.id);
  db.all(`SELECT * FROM group_topics WHERE group_id = ? ORDER BY created_at ASC`, [groupId], (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

// НОВОЕ: переименование ветки
app.post('/groups/:id/topics/update', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { topicId, name, requesterId } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false });
    if (!name || !name.trim()) return res.status(400).json({ success: false });

    db.run(`UPDATE group_topics SET name = ? WHERE id = ? AND group_id = ?`, [name.trim(), topicId, groupId], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`group_${groupId}`).emit('topic-updated', { groupId, topicId, name: name.trim() });
      res.json({ success: true });
    });
  });
});

// НОВОЕ: удаление ветки
app.post('/groups/:id/topics/delete', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { topicId, requesterId } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false });

    db.get(`SELECT * FROM group_topics WHERE id = ?`, [topicId], (err, topic) => {
      if (topic && topic.name === 'Общий чат') return res.status(403).json({ success: false, error: 'Нельзя удалить общий чат' });

      db.run(`DELETE FROM group_topics WHERE id = ?`, [topicId], function(err) {
        if (err) return res.status(500).json({ success: false });
        db.run(`DELETE FROM group_messages WHERE topic_id = ?`, [topicId]);
        io.to(`group_${groupId}`).emit('topic-deleted', { groupId, topicId });
        res.json({ success: true });
      });
    });
  });
});

// ===== СООБЩЕНИЯ ГРУППЫ =====
app.get('/groups/:id/messages', (req, res) => {
  const groupId = parseInt(req.params.id);
  const topicId = req.query.topicId ? parseInt(req.query.topicId) : null;

  let query, params;
  if (topicId) {
    query = `SELECT m.*, 
       (SELECT text FROM group_messages WHERE id = m.reply_to) AS reply_text,
       (SELECT from_user FROM group_messages WHERE id = m.reply_to) AS reply_from
     FROM group_messages m 
     WHERE m.group_id = ? AND m.topic_id = ? 
     ORDER BY m.timestamp ASC`;
    params = [groupId, topicId];
  } else {
    query = `SELECT m.*, 
       (SELECT text FROM group_messages WHERE id = m.reply_to) AS reply_text,
       (SELECT from_user FROM group_messages WHERE id = m.reply_to) AS reply_from
     FROM group_messages m 
     WHERE m.group_id = ? AND m.topic_id IS NULL 
     ORDER BY m.timestamp ASC`;
    params = [groupId];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json([]);
    const ids = rows.map(r => r.id);
    if (!ids.length) return res.json(rows);

    db.all(`SELECT * FROM message_reactions WHERE is_group = 1 AND message_id IN (${ids.join(',')})`, (err, reactions) => {
      if (!err && reactions) {
        rows.forEach(r => {
          r.reactions = reactions.filter(x => x.message_id === r.id).map(x => ({ emoji: x.emoji, user_id: x.user_id }));
        });
      }
      res.json(rows);
    });
  });
});

app.post('/groups/:id/messages/edit', (req, res) => {
  const { messageId, text, from } = req.body;
  db.get(`SELECT * FROM group_messages WHERE id = ?`, [messageId], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false });
    if (row.from_user !== from) return res.status(403).json({ success: false });
    db.run(`UPDATE group_messages SET text = ?, edited = 1 WHERE id = ?`, [text, messageId], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`group_${row.group_id}`).emit('group-message-edited', { id: messageId, text });
      res.json({ success: true });
    });
  });
});

app.post('/groups/:id/messages/delete', (req, res) => {
  const { messageId, from } = req.body;
  const groupId = parseInt(req.params.id);

  db.get(`SELECT * FROM group_messages WHERE id = ?`, [messageId], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false });
    db.get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, from], (err, member) => {
      if (!member) return res.status(403).json({ success: false });
      const isAuthor = row.from_user === from;
      const isAdmin = member.role === 'admin';
      if (!isAuthor && !isAdmin) return res.status(403).json({ success: false });
      db.run(`DELETE FROM group_messages WHERE id = ?`, [messageId], function(err) {
        if (err) return res.status(500).json({ success: false });
        io.to(`group_${groupId}`).emit('group-message-deleted', { id: messageId });
        res.json({ success: true });
      });
    });
  });
});

// ===== НОВОЕ: Закреплённые сообщения =====
app.post('/groups/:id/pin', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { messageId, requesterId, isGroupMessage } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false, error: 'Только создатель' });

    db.run(`UPDATE groups SET pinned_message_id = ? WHERE id = ?`, [messageId, groupId], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`group_${groupId}`).emit('group-pinned', { groupId, messageId });
      res.json({ success: true });
    });
  });
});

app.post('/groups/:id/unpin', (req, res) => {
  const groupId = parseInt(req.params.id);
  const { requesterId } = req.body;

  db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
    if (err || !group) return res.status(404).json({ success: false });
    if (group.creator_id !== requesterId) return res.status(403).json({ success: false });

    db.run(`UPDATE groups SET pinned_message_id = NULL WHERE id = ?`, [groupId], function(err) {
      if (err) return res.status(500).json({ success: false });
      io.to(`group_${groupId}`).emit('group-unpinned', { groupId });
      res.json({ success: true });
    });
  });
});

// ===== НОВОЕ: Реакции =====
app.post('/reactions/toggle', (req, res) => {
  const { messageId, userId, emoji, isGroup } = req.body;
  if (!messageId || !userId || !emoji) return res.status(400).json({ success: false });
  const isGrp = isGroup ? 1 : 0;

  db.get(`SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? AND is_group = ?`,
    [messageId, userId, emoji, isGrp],
    (err, row) => {
      if (row) {
        db.run(`DELETE FROM message_reactions WHERE id = ?`, [row.id], function(err) {
          if (err) return res.status(500).json({ success: false });
          const payload = { messageId, userId, emoji, isGroup: isGrp, removed: true };
          if (isGrp) {
            db.get(`SELECT group_id FROM group_messages WHERE id = ?`, [messageId], (err, m) => {
              if (m) io.to(`group_${m.group_id}`).emit('reaction-toggled', payload);
            });
          } else {
            io.emit('reaction-toggled', payload);
          }
          res.json({ success: true, removed: true });
        });
      } else {
        db.run(`INSERT INTO message_reactions (message_id, user_id, emoji, is_group) VALUES (?, ?, ?, ?)`,
          [messageId, userId, emoji, isGrp],
          function(err) {
            if (err) return res.status(500).json({ success: false });
            const payload = { messageId, userId, emoji, isGroup: isGrp };
            if (isGrp) {
              db.get(`SELECT group_id FROM group_messages WHERE id = ?`, [messageId], (err, m) => {
                if (m) io.to(`group_${m.group_id}`).emit('reaction-toggled', payload);
              });
            } else {
              io.emit('reaction-toggled', payload);
            }
            res.json({ success: true });
          }
        );
      }
    }
  );
});

// ===== WEBSOCKET =====
const onlineUsers = new Map();
const offlineTimers = new Map();

function broadcastOnlineUsers() {
  const list = [];
  onlineUsers.forEach((data, userId) => {
    list.push({ id: userId, status: data.status, lastSeen: data.lastSeen });
  });
  io.emit('online-users', list);
}

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
    socket.userId = userId;

    db.all(`SELECT group_id FROM group_members WHERE user_id = ?`, [userId], (err, rows) => {
      if (!err && rows) rows.forEach(r => socket.join(`group_${r.group_id}`));
    });

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, { sockets: new Set(), status: 'online', lastSeen: new Date() });
    }
    onlineUsers.get(userId).sockets.add(socket.id);
    onlineUsers.get(userId).status = 'online';

    if (offlineTimers.has(userId)) { clearTimeout(offlineTimers.get(userId)); offlineTimers.delete(userId); }
    broadcastOnlineUsers();
  });

  socket.on('away', (userId) => { if (onlineUsers.has(userId)) { onlineUsers.get(userId).status = 'away'; broadcastOnlineUsers(); } });
  socket.on('back', (userId) => { if (onlineUsers.has(userId)) { onlineUsers.get(userId).status = 'online'; broadcastOnlineUsers(); } });

  socket.on('typing', (data) => io.to(`user_${data.to}`).emit('user-typing', { from: data.from }));
  socket.on('stop-typing', (data) => io.to(`user_${data.to}`).emit('user-stop-typing', { from: data.from }));

  socket.on('message', (data) => {
    const { from, to, text, file, voice, tempId, replyTo } = data;
    db.run(
      `INSERT INTO messages (from_user, to_user, text, file, voice, reply_to) VALUES (?, ?, ?, ?, ?, ?)`,
      [from, to, text || null, file || null, voice || null, replyTo || null],
      function(err) {
        if (err) return console.error('Ошибка:', err);
        const message = {
          id: this.lastID, from_user: from, to_user: to,
          text: text || '', file: file || null, voice: voice || null,
          reply_to: replyTo || null, read: 0, tempId: tempId || null,
          timestamp: new Date(), reactions: []
        };
        io.to(`user_${to}`).emit('message', message);
        io.to(`user_${from}`).emit('message', message);
      }
    );
  });

  socket.on('mark-read', (data) => {
    const { from, to } = data;
    db.run(`UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?`, [from, to], function(err) {
      if (!err) io.to(`user_${from}`).emit('messages-read', { by: to });
    });
  });

  socket.on('group-message', (data) => {
    const { groupId, topicId, from, text, file, voice, tempId, replyTo } = data;
    db.run(
      `INSERT INTO group_messages (group_id, topic_id, from_user, text, file, voice, reply_to) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [groupId, topicId || null, from, text || null, file || null, voice || null, replyTo || null],
      function(err) {
        if (err) return console.error('Ошибка:', err);
        const message = {
          id: this.lastID, group_id: groupId, topic_id: topicId || null,
          from_user: from, text: text || '', file: file || null, voice: voice || null,
          reply_to: replyTo || null, tempId: tempId || null,
          timestamp: new Date(), reactions: []
        };
        io.to(`group_${groupId}`).emit('group-message', message);
      }
    );
  });

  socket.on('group-join', (groupId) => socket.join(`group_${groupId}`));
  socket.on('group-leave', (groupId) => socket.leave(`group_${groupId}`));

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
        }, 2 * 60 * 1000);
        offlineTimers.set(userId, t);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));