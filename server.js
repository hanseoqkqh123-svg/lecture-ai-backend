const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const db = require("./db");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

app.use(
  cors({
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("새 소켓 연결:", socket.id);

  socket.on("join_room", (data) => {
    if (data?.user_id) {
      socket.join(String(data.user_id));
      console.log(`user ${data.user_id} joined room`);
    }
  });

  socket.on("send_message", (data) => {
    console.log("받은 메시지:", data);

    if (data?.roomId) {
      io.to(String(data.roomId)).emit("receive_message", data);
    } else {
      socket.broadcast.emit("receive_message", data);
    }
  });

  socket.on("disconnect", () => {
    console.log("소켓 연결 종료:", socket.id);
  });
});

app.get("/", (req, res) => {
  res.send("🚀 캡스톤 9조 백엔드 서버가 성공적으로 켜졌습니다!");
});

// 회원가입
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "필수값이 누락되었습니다." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users (name, email, password)
      VALUES (?, ?, ?)
    `;

    db.query(sql, [name, email, hashedPassword], (err, result) => {
      if (err) {
        console.error("회원가입 오류:", err);
        return res.status(400).json({ message: "이미 사용 중인 이메일입니다." });
      }

      return res.status(201).json({ message: "회원가입 성공!" });
    });
  } catch (error) {
    console.error("회원가입 서버 오류:", error);
    return res.status(500).json({ message: "서버 에러" });
  }
});

// 로그인
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "이메일과 비밀번호를 입력해주세요." });
  }

  const sql = "SELECT * FROM users WHERE email = ?";

  db.query(sql, [email], async (err, results) => {
    if (err) {
      console.error("로그인 DB 오류:", err);
      return res.status(500).json({ message: "DB 오류" });
    }

    if (results.length === 0) {
      return res.status(401).json({ message: "계정이 없습니다." });
    }

    try {
      const user = results[0];
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({ message: "비밀번호가 올바르지 않습니다." });
      }

      return res.status(200).json({
        user: {
          user_id: user.user_id,
          name: user.name,
          email: user.email,
          icon: user.icon || "👽",
        },
      });
    } catch (error) {
      console.error("로그인 비교 오류:", error);
      return res.status(500).json({ message: "서버 에러" });
    }
  });
});

// 강의 저장
app.post("/api/lectures", (req, res) => {
  const { user_id, title, raw_text, summary_data } = req.body;

  if (!user_id || !title || !raw_text || !summary_data) {
    return res.status(400).json({ message: "강의 저장에 필요한 값이 부족합니다." });
  }

  console.log("받은 데이터 확인:", { user_id, title });

  const sql = `
    INSERT INTO lectures (user_id, title, raw_text, summary_data)
    VALUES (?, ?, ?, ?)
  `;

  db.query(
    sql,
    [user_id, title, raw_text, JSON.stringify(summary_data)],
    (err, result) => {
      if (err) {
        console.error("DB 저장 에러:", err);
        return res.status(500).json({ message: "강의 저장 실패" });
      }

      return res.status(201).json({
        message: "강의가 DB에 안전하게 저장되었습니다!",
        id: result.insertId,
      });
    }
  );
});

// 내 강의 목록 조회
app.get("/api/lectures/:userId", (req, res) => {
  const userId = req.params.userId;

  const sql = `
    SELECT * FROM lectures
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("불러오기 에러:", err);
      return res.status(500).json({ message: "데이터 불러오기 실패" });
    }

    return res.status(200).json(results);
  });
});

server.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: ${PORT}`);
});