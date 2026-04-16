const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const db = require("./db");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");
require("dotenv").config();

if (!fs.existsSync("uploads_tmp/")) fs.mkdirSync("uploads_tmp/", { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads_tmp/");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({ storage });

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    if (/^https:\/\/lecture-ai-ujen-.*\.vercel\.app$/.test(origin)) return true;
    return false;
}

app.use(
    cors({
        origin: function (origin, callback) {
            if (isAllowedOrigin(origin)) {
                callback(null, true);
            } else {
                callback(new Error("CORS 차단: " + origin));
            }
        },
        methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
        credentials: true,
    })
);

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: function (origin, callback) {
            if (isAllowedOrigin(origin)) {
                callback(null, true);
            } else {
                callback(new Error("Socket CORS 차단: " + origin));
            }
        },
        methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
        credentials: true,
    },
});

io.on("connection", (socket) => {
    console.log("새 소켓 연결:", socket.id);

    // 사용자의 고유 ID 방에 접속 (개인 알림용)
    socket.on("join_self", (userId) => {
        socket.join(`user_${userId}`);
    });

    socket.on("join_room",(roomId)=>{
        socket.join(String(roomId));
    });

    socket.on("send_message", (data) => {
    const roomId = String(data.roomId || "").trim();
    const sender_id = data.sender_id;
    const sender_name = data.sender_name || "익명";
    const text = String(data.text || "").trim();
    const client_temp_id = data.client_temp_id || null;

    if (!roomId || !sender_id || !text) return;

    const saveMessage = () => {
        const sql = "INSERT INTO chat_messages (room_id, sender_id, sender_name, message) VALUES (?, ?, ?, ?)";

        db.query(sql, [roomId, sender_id, sender_name, text], (err, result) => {
            if (err) {
                console.error("메시지 저장 실패:", err);
                return;
            }

            const messageData = {
                id: result.insertId,
                roomId,
                room_id: roomId,
                sender_id,
                sender_name,
                text,
                message: text,
                client_temp_id,
                created_at: new Date().toISOString(),
            };

            io.to(roomId).emit("receive_message", messageData);

            if (roomId.startsWith("private_")) {
                const [, firstId, secondId] = roomId.split("_");
                const targetId =
                    String(firstId) === String(sender_id)
                        ? String(secondId)
                        : String(firstId);

                io.to(`user_${targetId}`).emit("receive_message", messageData);
            }
        });
    };

    if (roomId === "team-room") {
        db.query(
            "INSERT IGNORE INTO chat_rooms (room_id, room_name, is_group) VALUES (?, ?, true)",
            [roomId, "전체 팀 채팅방"],
            (roomErr) => {
                if (roomErr) {
                    console.error("team-room 생성 실패:", roomErr);
                    return;
                }
                saveMessage();
            }
        );
        return;
    }

    if (roomId.startsWith("private_")) {
        const [, userA, userB] = roomId.split("_");

        db.query(
            "INSERT IGNORE INTO chat_rooms (room_id, room_name, is_group) VALUES (?, ?, false)",
            [roomId, "개인 채팅"],
            (roomErr) => {
                if (roomErr) {
                    console.error("개인 채팅방 생성 실패:", roomErr);
                    return;
                }

                const memberValues = [
                    [roomId, userA],
                    [roomId, userB],
                ];

                db.query(
                    "INSERT IGNORE INTO room_members (room_id, user_id) VALUES ?",
                    [memberValues],
                    (memberErr) => {
                        if (memberErr) {
                            console.error("개인 채팅 멤버 등록 실패:", memberErr);
                            return;
                        }

                        saveMessage();
                    }
                );
            }
        );
        return;
    }

    saveMessage();
});

    // 실시간 친구 요청/초대 알림
    socket.on("send_notification", (data) => {
        // data: { targetId, type, message, payload }
        io.to(`user_${data.targetId}`).emit("new_notification", data);
    });

    socket.on("disconnect", () => {
        console.log("소켓 연결 종료:", socket.id);
    });
});

app.get("/", (req, res) => {
    res.send("🚀 캡스톤 9조 백엔드 서버가 성공적으로 켜졌습니다!");
});

// 친구 검색 및 요청
// 친구 요청 API (이메일로 친구 추가)
// 친구 검색 및 요청
// 친구 요청 API (수락/거절 가능한 버전)
app.post("/api/friends/request", (req, res) => {
    const { userId, friendEmail, senderName } = req.body;

    if (!userId || !friendEmail || !friendEmail.trim()) {
        return res.status(400).json({ message: "userId와 friendEmail이 필요합니다." });
    }

    db.query(
        "SELECT user_id, name, email FROM users WHERE email = ?",
        [friendEmail.trim()],
        (err, results) => {
            if (err) return res.status(500).json({ message: "DB 에러" });
            if (results.length === 0) {
                return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
            }

            const targetUser = results[0];
            const friendId = targetUser.user_id;

            if (String(userId) === String(friendId)) {
                return res.status(400).json({ message: "본인은 추가할 수 없습니다." });
            }

            const checkSql = `
                SELECT user_id, friend_id, status
                FROM friends
                WHERE (user_id = ? AND friend_id = ?)
                   OR (user_id = ? AND friend_id = ?)
            `;

            db.query(checkSql, [userId, friendId, friendId, userId], (checkErr, rows) => {
                if (checkErr) {
                    console.error("친구 관계 확인 실패:", checkErr);
                    return res.status(500).json({ message: "친구 요청 확인 실패" });
                }

                const alreadyFriend = rows.find((row) => row.status === "accepted");
                if (alreadyFriend) {
                    return res.status(409).json({ message: "이미 친구입니다." });
                }

                const alreadySent = rows.find(
                    (row) =>
                        String(row.user_id) === String(userId) &&
                        String(row.friend_id) === String(friendId) &&
                        row.status === "pending"
                );
                if (alreadySent) {
                    return res.status(409).json({ message: "이미 친구 요청을 보냈습니다." });
                }

                const incomingPending = rows.find(
                    (row) =>
                        String(row.user_id) === String(friendId) &&
                        String(row.friend_id) === String(userId) &&
                        row.status === "pending"
                );
                if (incomingPending) {
                    return res.status(409).json({
                        message: "상대가 먼저 친구 요청을 보냈습니다. 받은 요청에서 수락해주세요.",
                    });
                }

                db.query(
                    "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')",
                    [userId, friendId],
                    (insertErr) => {
                        if (insertErr) {
                            console.error("친구 요청 저장 실패:", insertErr);
                            return res.status(500).json({ message: "친구 요청 실패" });
                        }

                        io.to(`user_${friendId}`).emit("new_notification", {
                            type: "friend_request",
                            targetId: friendId,
                            requesterId: userId,
                            message: `${senderName || "누군가"}님이 친구 요청을 보냈습니다.`,
                        });

                        return res.status(200).json({
                            message: "친구 요청을 보냈습니다.",
                            friendId,
                            friendName: targetUser.name,
                        });
                    }
                );
            });
        }
    );
});

// 받은 친구 요청 목록
app.get("/api/friends/requests/:userId", (req, res) => {
    const userId = req.params.userId;

    const sql = `
        SELECT u.user_id, u.name, u.email
        FROM friends f
        JOIN users u ON u.user_id = f.user_id
        WHERE f.friend_id = ?
          AND f.status = 'pending'
        ORDER BY u.name ASC
    `;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("받은 친구 요청 조회 실패:", err);
            return res.status(500).json({ message: "받은 친구 요청 조회 실패" });
        }
        return res.status(200).json(results);
    });
});

// 보낸 친구 요청 목록
app.get("/api/friends/requests/sent/:userId", (req, res) => {
    const userId = req.params.userId;

    const sql = `
        SELECT u.user_id, u.name, u.email
        FROM friends f
        JOIN users u ON u.user_id = f.friend_id
        WHERE f.user_id = ?
          AND f.status = 'pending'
        ORDER BY u.name ASC
    `;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("보낸 친구 요청 조회 실패:", err);
            return res.status(500).json({ message: "보낸 친구 요청 조회 실패" });
        }
        return res.status(200).json(results);
    });
});

// 친구 요청 수락 / 거절
app.patch("/api/friends/request/respond", (req, res) => {
    const { userId, requesterId, responderName, action } = req.body;

    if (!userId || !requesterId || !["accepted", "rejected"].includes(action)) {
        return res.status(400).json({ message: "필수값이 누락되었거나 action이 올바르지 않습니다." });
    }

    db.query(
        "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
        [requesterId, userId],
        (checkErr, rows) => {
            if (checkErr) {
                console.error("친구 요청 확인 실패:", checkErr);
                return res.status(500).json({ message: "친구 요청 확인 실패" });
            }

            if (rows.length === 0) {
                return res.status(404).json({ message: "처리할 친구 요청이 없습니다." });
            }

            if (action === "accepted") {
                db.query(
                    "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
                    [requesterId, userId],
                    (updateErr) => {
                        if (updateErr) {
                            console.error("친구 요청 수락 실패:", updateErr);
                            return res.status(500).json({ message: "친구 요청 수락 실패" });
                        }

                        io.to(`user_${requesterId}`).emit("new_notification", {
                            type: "friend_accepted",
                            targetId: requesterId,
                            responderId: userId,
                            message: `${responderName || "상대"}님이 친구 요청을 수락했습니다.`,
                        });

                        return res.status(200).json({ message: "친구 요청을 수락했습니다." });
                    }
                );
            } else {
                db.query(
                    "DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
                    [requesterId, userId],
                    (deleteErr) => {
                        if (deleteErr) {
                            console.error("친구 요청 거절 실패:", deleteErr);
                            return res.status(500).json({ message: "친구 요청 거절 실패" });
                        }

                        io.to(`user_${requesterId}`).emit("new_notification", {
                            type: "friend_rejected",
                            targetId: requesterId,
                            responderId: userId,
                            message: `${responderName || "상대"}님이 친구 요청을 거절했습니다.`,
                        });

                        return res.status(200).json({ message: "친구 요청을 거절했습니다." });
                    }
                );
            }
        }
    );
});

// 내 친구 목록 조회 API
app.get("/api/friends/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
        SELECT DISTINCT u.user_id, u.name, u.email 
        FROM users u
        JOIN friends f ON (u.user_id = f.friend_id OR u.user_id = f.user_id)
        WHERE (f.user_id = ? OR f.friend_id = ?) 
          AND u.user_id != ? 
          AND f.status = 'accepted'
    `;
    db.query(sql, [userId, userId, userId], (err, results) => {
        if (err) return res.status(500).json({ message: "친구 목록 조회 실패" });
        res.status(200).json(results);
    });
});

// 단체 채팅방 생성 API (Internal Server Error 방지 버전)
app.post("/api/chat/rooms", (req, res) => {
    const { roomName, members } = req.body; 
    if (!members || members.length === 0) return res.status(400).json({ message: "멤버가 없습니다." });

    const roomId = `group_${Date.now()}`; 

    // 1. 방 정보 저장
    db.query("INSERT INTO chat_rooms (room_id, room_name, is_group) VALUES (?, ?, true)", [roomId, roomName], (err) => {
        if (err) {
            console.error("방 생성 DB 에러:", err);
            return res.status(500).json({ message: "방 생성 실패" });
        }

        // 2. 멤버 등록 (중첩 배열 구조로 전달)
        const values = members.map(id => [roomId, id]);
        db.query("INSERT INTO room_members (room_id, user_id) VALUES ?", [values], (err) => {
            if (err) {
                console.error("멤버 등록 DB 에러:", err);
                return res.status(500).json({ message: "멤버 초대 실패" });
            }
            res.status(201).json({ roomId, roomName });
        });
    });
});

// 내가 속한 단체 채팅방 목록 조회
app.get("/api/chat/rooms/:userId", (req, res) => {
    const userId = req.params.userId;

    const sql = `
        SELECT DISTINCT
            cr.room_id,
            cr.room_name,
            cr.is_group
        FROM chat_rooms cr
        JOIN room_members rm ON cr.room_id = rm.room_id
        WHERE rm.user_id = ?
          AND cr.room_id LIKE 'group_%'
        ORDER BY cr.room_id DESC
    `;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("채팅방 목록 조회 실패:", err);
            return res.status(500).json({ message: "채팅방 목록 조회 실패" });
        }

        return res.status(200).json(results);
    });
});

// 채팅 내역 조회
app.get("/api/chat/messages/:roomId", (req, res) => {
    const sql = `
        SELECT
            id,
            room_id AS roomId,
            sender_id,
            sender_name,
            message AS text,
            created_at
        FROM chat_messages
        WHERE room_id = ?
        ORDER BY created_at ASC
    `;

    db.query(sql, [req.params.roomId], (err, results) => {
        if (err) {
            console.error("메시지 조회 실패:", err);
            return res.status(500).json({ message: "메시지 조회 실패" });
        }
        res.status(200).json(results);
    });
});

// 회원가입
app.post("/api/signup", async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: "필수값이 누락되었습니다." });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`;

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

    console.log("📥 summary_data 타입:", typeof summary_data);
    console.log("📥 저장 요청 받음:", { user_id, title });

    if (!user_id || !title || !raw_text || !summary_data) {
        console.log("❌ 누락된 값:", { user_id: !!user_id, title: !!title, raw_text: !!raw_text, summary_data: !!summary_data });
        return res.status(400).json({ message: "강의 저장에 필요한 값이 부족합니다." });
    }

    const sql = `INSERT INTO lectures (user_id, title, raw_text, summary_data) VALUES (?, ?, ?, ?)`;

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

// 강의 수정
app.put("/api/lectures/:lectureId", (req, res) => {
    const lectureId = req.params.lectureId;
    const { user_id, title, raw_text, summary_data } = req.body;

    if (!user_id || !title || !raw_text || !summary_data) {
        return res.status(400).json({ message: "필수값이 누락되었습니다." });
    }

    const sql = `UPDATE lectures SET title = ?, raw_text = ?, summary_data = ? WHERE id = ? AND user_id = ?`;

    db.query(sql, [title, raw_text, JSON.stringify(summary_data), lectureId, user_id], (err, result) => {
        if (err) {
            console.error("강의 수정 오류:", err);
            return res.status(500).json({ message: "강의 수정 실패" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "강의를 찾을 수 없거나 권한이 없습니다." });
        }
        return res.status(200).json({ message: "강의가 수정되었습니다." });
    });
});

// 퀴즈 히스토리 저장
app.post("/api/quiz-history", (req, res) => {
    const { user_id, lecture_id, lecture_title, score, correct, total, results } = req.body;

    if (!user_id || score === undefined) {
        return res.status(400).json({ message: "필수값이 누락되었습니다." });
    }

    if (!lecture_id) {
        return res.status(400).json({ message: "강의를 먼저 저장한 후 퀴즈를 제출해주세요." });
    }

    const sql = `INSERT INTO quiz_history (user_id, lecture_id, lecture_title, score, correct, total, results) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [user_id, lecture_id, lecture_title, score, correct, total, JSON.stringify(results || [])], (err, result) => {
        if (err) {
            console.error("퀴즈 히스토리 저장 오류:", err);
            return res.status(500).json({ message: "히스토리 저장 실패" });
        }
        return res.status(201).json({ message: "퀴즈 히스토리 저장 완료", id: result.insertId });
    });
});

// 퀴즈 히스토리 삭제
app.delete("/api/quiz-history/:historyId", (req, res) => {
    const historyId = req.params.historyId;
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ message: "user_id가 필요합니다." });
    }

    const sql = `DELETE FROM quiz_history WHERE id = ? AND user_id = ?`;

    db.query(sql, [historyId, user_id], (err, result) => {
        if (err) {
            console.error("퀴즈 히스토리 삭제 오류:", err);
            return res.status(500).json({ message: "히스토리 삭제 실패" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "기록을 찾을 수 없거나 권한이 없습니다." });
        }
        return res.status(200).json({ message: "퀴즈 히스토리가 삭제되었습니다." });
    });
});

// 퀴즈 히스토리 조회
app.get("/api/quiz-history/:userId", (req, res) => {
    const userId = req.params.userId;

    const sql = `SELECT * FROM quiz_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("퀴즈 히스토리 조회 오류:", err);
            return res.status(500).json({ message: "히스토리 조회 실패" });
        }
        return res.status(200).json(results);
    });
});

// 강의 삭제
// 강의 삭제
app.delete("/api/lectures/:lectureId", (req, res) => {
  const lectureId = req.params.lectureId;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "user_id가 필요합니다." });
  }

  const deleteQuizHistorySql = `DELETE FROM quiz_history WHERE lecture_id = ? AND user_id = ?`;
  const deleteLectureSql = `DELETE FROM lectures WHERE id = ? AND user_id = ?`;

  db.query(deleteQuizHistorySql, [lectureId, user_id], (quizErr) => {
    if (quizErr) {
      console.error("퀴즈 히스토리 삭제 오류:", quizErr);
      return res.status(500).json({ message: "연결된 퀴즈 기록 삭제 실패" });
    }

    db.query(deleteLectureSql, [lectureId, user_id], (err, result) => {
      if (err) {
        console.error("강의 삭제 오류:", err);
        return res.status(500).json({ message: "강의 삭제 실패" });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "강의를 찾을 수 없거나 권한이 없습니다." });
      }

      return res.status(200).json({ message: "강의가 삭제되었습니다." });
    });
  });
});

// 내 강의 목록 조회
app.get("/api/lectures/:userId", (req, res) => {
    const userId = req.params.userId;
    console.log("📌 강의 목록 요청 userId:", userId);

    const sql = `SELECT * FROM lectures WHERE user_id = ? ORDER BY created_at DESC`;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("불러오기 에러:", err);
            return res.status(500).json({ message: "데이터 불러오기 실패" });
        }
        console.log("✅ 조회 결과:", results.length, "건");

        return res.status(200).json(results);
    });
});

const userContextMap = new Map();

function getUserContext(userId) {
  return userContextMap.get(String(userId)) || "";
}

function setUserContext(userId, text) {
  const prev = getUserContext(userId);
  const next = `${prev} ${text}`.trim().slice(-2000);
  userContextMap.set(String(userId), next);
}

async function refineText(text) {
  if (!text || !text.trim()) return "";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `다음은 강의 음성인식 결과입니다.
의미는 바꾸지 말고 표기만 교정하세요.

규칙:
- 영어 약어는 원형 유지: API, HTTP, CNN, GPT, LLM, SQL
- 프로그래밍 언어/기술명은 표준 표기로 교정: C++, C#, JavaScript, TypeScript, Node.js, Python, Java
- 숫자/기호/수식은 문맥상 명확하면 숫자와 기호로 교정
- 발음대로 적힌 기술 용어를 표준 표기로 바꾸세요
- 임의 요약, 내용 추가, 삭제 금지
- 결과는 교정된 본문만 출력

예시:
- "파이썬" -> "Python"
- "씨플플" -> "C++"
- "에이피아이" -> "API"
- "에이치티티피" -> "HTTP"
- "에스큐엘" -> "SQL"
- "노드 제이에스" -> "Node.js"
- "자바 스크립트" -> "JavaScript"
- "타입 스크립트" -> "TypeScript"`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "전사 보정 실패");
  }

  return data.choices?.[0]?.message?.content?.trim() || text;
}

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "오디오 파일이 없습니다." });
  }

  const tmpPath = req.file.path;

  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY가 설정되지 않았습니다.");
    }

    if (req.file.size < 4000) {
      return res.status(200).json({ text: "" });
    }

    const originalExt = path.extname(req.file.originalname || "").toLowerCase() || ".webm";
    const contentType =
      req.file.mimetype ||
      (originalExt === ".webm"
        ? "audio/webm"
        : originalExt === ".ogg"
        ? "audio/ogg"
        : originalExt === ".mp4" || originalExt === ".m4a"
        ? "audio/mp4"
        : "application/octet-stream");

    const userId = req.body.userId || req.query.userId || "default";
    const prevContext = getUserContext(userId);

    const formData = new FormData();
    formData.append("file", fs.createReadStream(tmpPath), {
      filename: `audio${originalExt}`,
      contentType,
    });
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("language", "ko");
    formData.append("temperature", "0");
    formData.append("response_format", "verbose_json");

    const whisperRes = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    const rawText = await whisperRes.text();

    if (!whisperRes.ok) {
      console.error("Groq Whisper 실패:", rawText);
      throw new Error(`Whisper API 실패: ${whisperRes.status}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("Whisper 응답 JSON 파싱 실패:", rawText);
      throw new Error("Whisper 응답 파싱에 실패했습니다.");
    }

    let text = "";
    if (Array.isArray(parsed.segments)) {
      text = parsed.segments
        .filter((seg) => (seg.avg_logprob ?? -1) > -0.9)
        .map((seg) => String(seg.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      text = String(parsed.text || "").replace(/\s+/g, " ").trim();
    }

    text = text.replace(/(.{4,15}?)( \1){1,}/g, "$1");
    text = text.replace(/(감사합니다\.?)( \1)+/g, "$1");
    text = text.replace(/(안녕하세요\.?)( \1)+/g, "$1");

    const garbagePatterns = [
  /^안녕하세요[.! ]*$/u,
  /^감사합니다[.! ]*$/u,
  /^(감사합니다[.! ]*){2,}$/u,
  /^(안녕하세요[.! ]*){2,}$/u
];

if (garbagePatterns.some((p) => p.test(text))) {
  text = "";
}

const bannedPhrases = [
  "한국어 강의를 정확히 전사하세요.",
  "이 음성은 학교 강의입니다. 한국어로 정확하게 전사하세요. 수식, 전공 용어, 영어 약어(예: CNN, HTTP, API)는 들린 그대로 유지하세요. 문장이 자연스럽게 이어지도록 하되 내용을 임의로 추가하거나 요약하지 마세요."
];

if (bannedPhrases.some((phrase) => text.includes(phrase))) {
  text = "";
}

// 이거 있으니까 계속 이상한말 반복하길래 일단 주석처리함
// if (text) {
//  text = await refineText(text);
//}

// 마지막에 사용자 문맥 저장 인데 애가 계속 반복하고 이상해서 주석처리함
//if (text) {
//  setUserContext(userId, text);
//}

return res.status(200).json({ text });
  } catch (error) {
    console.error("/api/transcribe 오류:", error);
    return res.status(500).json({
      message: error.message || "음성 변환 중 서버 오류가 발생했습니다.",
    });
  } finally {
    try {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (e) {
      console.error("tmp 파일 삭제 실패:", e);
    }
  }
});

// 퀴즈 채점 - GPT
app.post("/api/grade", async (req, res) => {
    const { question, correctAnswer, userAnswer } = req.body;

    if (!question || !correctAnswer || !userAnswer) {
        return res.status(400).json({ message: "필수값이 누락되었습니다." });
    }

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: `다음 퀴즈 채점을 해줘. 반드시 JSON 형식으로만 응답해. 다른 텍스트는 절대 포함하지 마.

질문: ${question}
모범 답안: ${correctAnswer}
학생 답변: ${userAnswer}

채점 기준:
- 핵심 개념이 포함되어 있으면 정답으로 처리
- 완전히 동일하지 않아도 의미가 맞으면 정답
- 방향이 맞지만 불완전하면 부분 정답

응답 형식:
{
  "isCorrect": true 또는 false,
  "feedback": "짧은 피드백 (1~2문장)"
}`,
                    },
                ],
            }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "GPT 채점 실패");

        const raw = data.choices[0].message.content.trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("JSON 파싱 실패");

        const parsed = JSON.parse(jsonMatch[0]);
        return res.status(200).json({
            isCorrect: !!parsed.isCorrect,
            feedback: parsed.feedback || "",
        });
    } catch (error) {
        console.error("채점 오류:", error);
        return res.status(500).json({ message: error.message || "채점 오류" });
    }
});

// 요약 / 키워드 / 퀴즈 - GPT
app.post("/api/summarize", async (req, res) => {
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ message: "텍스트가 없습니다." });
    }

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: `다음 강의 내용을 분석해서 반드시 아래 JSON 형식으로만 응답해. 분야에 상관없이(인문, 과학, 공학, 예술 등) 핵심 내용을 추출해줘.

강의 내용:
"""
${text.slice(0, 8000)}
"""

응답 형식:
{
  "summary": "강의의 전체적인 맥락과 핵심 논리를 포함한 3~5문장 요약",
  "keywords": ["주제와 관련된 가장 중요하고 시험에 나올법한 핵심 용어 5개"],
  "quiz": [
    { "question": "강의 내용의 핵심 원리나 개념을 묻는 추론형 질문1", "answer": "구체적인 근거가 포함된 답안1" },
    { "question": "강의에서 강조된 주요 사례나 이론을 확인하는 질문2", "answer": "구체적인 근거가 포함된 답안2" },
    { "question": "학습자가 개념을 응용해볼 수 있는 질문3", "answer": "구체적인 근거가 포함된 답안3" }
  ]
}`,
                    },
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "GPT 요청 실패");
        }

        const raw = data.choices[0].message.content.trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("JSON 파싱 실패");

        const parsed = JSON.parse(jsonMatch[0]);

        return res.status(200).json({
            summary: parsed.summary || "",
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
            quiz: Array.isArray(parsed.quiz) ? parsed.quiz : [],
        });
    } catch (error) {
        console.error("GPT 오류:", error);
        return res.status(500).json({ message: error.message || "요약 생성 오류" });
    }
});

server.listen(PORT, () => {
    console.log(`✅ 서버 실행 중: ${PORT}`);
});

