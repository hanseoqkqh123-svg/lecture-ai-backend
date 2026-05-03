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
const { execFile } = require("child_process");
const jwt = require("jsonwebtoken");
const ffmpeg = require("fluent-ffmpeg"); // npm install fluent-ffmpeg
const ffmpegPath = require("ffmpeg-static"); //npm install fluent-ffmpeg ffmpeg-static
ffmpeg.setFfmpegPath(ffmpegPath);

require("dotenv").config();

const lectureUploadDir = "lecture_uploads/";
if (!fs.existsSync(lectureUploadDir)) {
    fs.mkdirSync(lectureUploadDir, { recursive: true });
}

const lectureFileStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, lectureUploadDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});

const lectureFileUpload = multer({ storage: lectureFileStorage });

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

function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioChannels(1)
            .audioFrequency(16000)
            .format("wav")
            .on("end", () => resolve(outputPath))
            .on("error", (err) => reject(err))
            .save(outputPath);
    });
}
if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET 환경변수가 설정되지 않았습니다. 서버를 종료합니다.");
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use("/lecture_uploads", express.static("lecture_uploads"));

const allowedOrigins = [
    "http://localhost:3000",
    process.env.FRONTEND_URL,
].filter(Boolean);

function createToken(user) {
    return jwt.sign(
        user,
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
}

function requireAuth(req, res, next) {
    const auth = req.headers.authorization || "";
    const token = auth.split(" ")[1];

    if (!token) {
        return res.status(401).json({ message: "인증 필요" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        req.user = decoded;
        next();
    } catch {
        return res.status(401).json({ message: "토큰 오류" });
    }
}

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

app.set("io", io);

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error("인증 필요"));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        socket.user = decoded;
        next();
    } catch (err) {
        return next(new Error("토큰 오류"));
    }
});

io.on("connection", (socket) => {
    console.log("새 소켓 연결:", socket.id, "user:", socket.user?.user_id);

    // 인증된 자기 방만 입장
    socket.join(`user_${socket.user.user_id}`);

    socket.on("join_self", () => {
        socket.join(`user_${socket.user.user_id}`);
    });

    socket.on("join_room", (roomId) => {
        const safeRoomId = String(roomId || "").trim();
        if (!safeRoomId) return;

        // team-room은 허용
        if (safeRoomId === "team-room") {
            socket.join("team-room");
            return;
        }

        // private_방은 본인 포함일 때만 허용
        if (safeRoomId.startsWith("private_")) {
            const [, a, b] = safeRoomId.split("_");
            const me = String(socket.user.user_id);

            if (me !== String(a) && me !== String(b)) {
                return;
            }

            socket.join(safeRoomId);
            return;
        }

        // group_방은 DB 멤버일 때만 허용
        if (safeRoomId.startsWith("group_")) {
            db.query(
                "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
                [safeRoomId, socket.user.user_id],
                (err, rows) => {
                    if (err) {
                        console.error("채팅방 권한 확인 실패:", err);
                        return;
                    }
                    if (rows.length > 0) {
                        socket.join(safeRoomId);
                    }
                }
            );
        }
    });

    socket.on("send_message", (data) => {
        const roomId = String(data.roomId || "").trim();
        const sender_id = socket.user.user_id;
        const sender_name = socket.user.name || "익명";
        const text = String(data.text || "").trim();
        const client_temp_id = data.client_temp_id || null;

        if (!roomId || !text) return;

        const saveMessage = () => {
            const sql =
                "INSERT INTO chat_messages (room_id, sender_id, sender_name, message) VALUES (?, ?, ?, ?)";

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
            const me = String(sender_id);

            if (me !== String(userA) && me !== String(userB)) {
                return;
            }

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

        if (roomId.startsWith("group_")) {
            db.query(
                "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
                [roomId, sender_id],
                (memberErr, rows) => {
                    if (memberErr) {
                        console.error("그룹 채팅 권한 확인 실패:", memberErr);
                        return;
                    }
                    if (rows.length === 0) return;
                    saveMessage();
                }
            );
            return;
        }
    });

    socket.on("send_notification", (data) => {
        const targetId = String(data.targetId || "").trim();
        const allowedTypes = ["friend_request", "friend_accepted", "friend_rejected"];

        if (!targetId) return;
        if (!allowedTypes.includes(data.type)) return;

        const messageMap = {
            friend_request: `${socket.user.name}님이 친구 요청을 보냈습니다.`,
            friend_accepted: `${socket.user.name}님이 친구 요청을 수락했습니다.`,
            friend_rejected: `${socket.user.name}님이 친구 요청을 거절했습니다.`,
        };

        io.to(`user_${targetId}`).emit("new_notification", {
            type: data.type,
            targetId,
            senderId: socket.user.user_id,
            message: messageMap[data.type],
        });
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
app.post("/api/friends/request", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const { friendEmail, senderName } = req.body;

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
app.get("/api/friends/requests/:userId", requireAuth, (req, res) => {
    const userId = req.user.user_id;

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
app.get("/api/friends/requests/sent/:userId", requireAuth, (req, res) => {
    const requestedUserId = String(req.params.userId);
    const tokenUserId = String(req.user.user_id);

    if (requestedUserId !== tokenUserId) {
        return res.status(403).json({ message: "접근 권한이 없습니다." });
    }

    const userId = tokenUserId;

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
app.patch("/api/friends/request/respond", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const { requesterId, responderName, action } = req.body;

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
app.get("/api/friends/:userId", requireAuth, (req, res) => {
    const userId = req.user.user_id;
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
app.post("/api/chat/rooms", requireAuth, (req, res) => {
    const creatorId = req.user.user_id;
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
app.get("/api/chat/rooms/:userId", requireAuth, (req, res) => {
    const requestedUserId = String(req.params.userId);
    const tokenUserId = String(req.user.user_id);

    if (requestedUserId !== tokenUserId) {
        return res.status(403).json({ message: "접근 권한이 없습니다." });
    }

    const userId = tokenUserId;

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
app.get("/api/chat/messages/:roomId", requireAuth, (req, res) => {
    const roomId = String(req.params.roomId || "").trim();
    const userId = req.user.user_id;

    if (roomId === "team-room") {
        return loadMessages();
    }

    if (roomId.startsWith("private_")) {
        const [, a, b] = roomId.split("_");
        const me = String(userId);
        if (me !== String(a) && me !== String(b)) {
            return res.status(403).json({ message: "접근 권한이 없습니다." });
        }
        return loadMessages();
    }

    db.query(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
        [roomId, userId],
        (err, rows) => {
            if (err) {
                console.error("메시지 조회 권한 확인 실패:", err);
                return res.status(500).json({ message: "권한 확인 실패" });
            }
            if (rows.length === 0) {
                return res.status(403).json({ message: "접근 권한이 없습니다." });
            }
            return loadMessages();
        }
    );

    function loadMessages() {
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

        db.query(sql, [roomId], (err, results) => {
            if (err) {
                console.error("메시지 조회 실패:", err);
                return res.status(500).json({ message: "메시지 조회 실패" });
            }
            return res.status(200).json(results);
        });
    }
});

const nodemailer = require("nodemailer");
const crypto = require("crypto");

// 1. 네이버 메일 전송 설정
const naverTransporter = nodemailer.createTransport({
    host: "smtp.naver.com",
    port: 465,
    secure: true, // SSL 사용
    auth: {
        user: process.env.NAVER_USER, // 네이버 아이디 (예: abc@naver.com)
        pass: process.env.NAVER_PASS  // 네이버 앱 비밀번호
    }
});

// 2. 지메일 설정
const gmailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// 1. 회원가입 API (네이버 메일 발송 로직 포함)
app.post("/api/signup", async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verifyUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/verify-email?token=${verificationToken}`;

        const sql = `INSERT INTO users (name, email, password, verification_token, is_verified) VALUES (?, ?, ?, ?, false)`;
        db.query(sql, [name, email, hashedPassword, verificationToken], (err) => {
            if (err) return res.status(400).json({ message: "이미 사용 중인 이메일입니다." });

            const mailOptions = {
                from: `Lecture AI <${process.env.NAVER_USER}>`,
                to: email,
                subject: '[Lecture AI] 회원가입 완료를 위해 이메일 인증을 진행해주세요',
                html: `
          <div style="background: #f9fafb; padding: 40px; font-family: sans-serif;">
            <div style="max-width: 500px; margin: 0 auto; background: white; padding: 20px; border-radius: 12px; border: 1px solid #eee;">
              <h2 style="color: #2383e2;">안녕하세요, ${name}님! 👋</h2>
              <p>Lecture AI에 가입해주셔서 감사합니다. 아래 버튼을 눌러 인증을 완료해주세요.</p>
              <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #2383e2; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0;">이메일 인증하기</a>
              <p style="font-size: 12px; color: #999;">인증 완료 전까지는 로그인이 불가능합니다.</p>
            </div>
          </div>
        `
            };

            const transporter = email.includes("naver.com") ? naverTransporter : gmailTransporter;
            const fromUser = email.includes("naver.com") ? process.env.NAVER_USER : process.env.GMAIL_USER;

            mailOptions.from = `Lecture AI <${fromUser}>`;

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) {
                    console.error("메일 발송 실패:", mailErr);
                    return res.status(500).json({ message: "메일 발송 실패" });
                }
                return res.status(201).json({ message: "인증 메일이 발송되었습니다." });
            });
        });
    } catch (e) { res.status(500).json({ message: "서버 에러" }); }
});


// 2. 이메일 인증 확인 API (링크 클릭 시)
app.get("/api/verify-email", (req, res) => {
    const { token } = req.query;
    const sql = "UPDATE users SET is_verified = true, verification_token = NULL WHERE verification_token = ?";

    db.query(sql, [token], (err, result) => {
        if (err || result.affectedRows === 0) {
            return res.status(400).send("<h1>인증 실패</h1><p>만료된 토큰이거나 잘못된 접근입니다.</p>");
        }
        res.status(200).send("<h1>인증 완료! ✨</h1><p>이제 로그인하실 수 있습니다. 창을 닫고 로그인을 진행해주세요.</p>");
    });
});

// 3. 로그인 API (is_verified 체크 추가)
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM users WHERE email = ?";

    db.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ message: "DB 오류" });
        if (results.length === 0) return res.status(401).json({ message: "가입되지 않은 이메일입니다." });

        const user = results[0];

        // 핵심: 인증 여부를 먼저 확인하고 에러 메시지를 다르게 보냄
        if (!user.is_verified) {
            return res.status(403).json({ message: "❌ 이메일 인증이 완료되지 않았습니다. 메일함을 확인해주세요!" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "비밀번호가 틀렸습니다." });

        const safeUser = { user_id: user.user_id, name: user.name, email: user.email };
        const token = createToken(safeUser);
        return res.status(200).json({ token, user: safeUser });
    });
});
// 인증 메일 재발송 API
app.post("/api/resend-verification", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "이메일이 필요합니다." });

    db.query("SELECT * FROM users WHERE email = ?", [email.trim()], async (err, results) => {
        if (err) return res.status(500).json({ message: "DB 오류" });
        if (results.length === 0) return res.status(404).json({ message: "가입되지 않은 이메일입니다." });

        const user = results[0];
        if (user.is_verified) return res.status(400).json({ message: "이미 인증된 이메일입니다." });

        const newToken = crypto.randomBytes(32).toString("hex");
        const verifyUrl = `${process.env.BACKEND_URL || "http://localhost:5000"}/api/verify-email?token=${newToken}`;

        db.query("UPDATE users SET verification_token = ? WHERE email = ?", [newToken, email.trim()], (updateErr) => {
            if (updateErr) return res.status(500).json({ message: "토큰 업데이트 실패" });

            const transporter = email.includes("naver.com") ? naverTransporter : gmailTransporter;
            const fromUser = email.includes("naver.com") ? process.env.NAVER_USER : process.env.GMAIL_USER;

            transporter.sendMail({
                from: `Lecture AI <${fromUser}>`,
                to: email.trim(),
                subject: "[Lecture AI] 인증 메일 재발송",
                html: `
                  <div style="background:#f9fafb;padding:40px;font-family:sans-serif;">
                    <div style="max-width:500px;margin:0 auto;background:white;padding:20px;border-radius:12px;border:1px solid #eee;">
                      <h2 style="color:#2383e2;">인증 메일 재발송 안내</h2>
                      <p>아래 버튼을 눌러 이메일 인증을 완료해주세요.</p>
                      <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#2383e2;color:white;text-decoration:none;border-radius:8px;font-weight:bold;margin:20px 0;">이메일 인증하기</a>
                      <p style="font-size:12px;color:#999;">이전 인증 링크는 더 이상 사용할 수 없습니다.</p>
                    </div>
                  </div>
                `,
            }, (mailErr) => {
                if (mailErr) {
                    console.error("재발송 메일 실패:", mailErr);
                    return res.status(500).json({ message: "메일 발송 실패" });
                }
                return res.status(200).json({ message: "인증 메일이 재발송되었습니다." });
            });
        });
    });
});

// 강의 저장
app.post("/api/lectures", requireAuth, lectureFileUpload.array("files", 10), (req, res) => {
    const user_id = req.user.user_id;
    const { title, raw_text, summary_data } = req.body;

    const files = (req.files || []).map((file) => ({
        originalName: file.originalname,
        filename: file.filename,
        path: `/lecture_uploads/${file.filename}`,
        mimetype: file.mimetype,
    }));

    if (!title || !raw_text || !summary_data) {
        return res.status(400).json({ message: "강의 저장에 필요한 값이 부족합니다." });
    }

    let parsedSummaryData = {};
    try {
        parsedSummaryData =
            typeof summary_data === "string"
                ? JSON.parse(summary_data)
                : summary_data;
    } catch {
        parsedSummaryData = {};
    }

    const fullSummaryData = {
        ...parsedSummaryData,
        files,
    };

    const sql = `INSERT INTO lectures (user_id, title, raw_text, summary_data) VALUES (?, ?, ?, ?)`;

    db.query(
        sql,
        [user_id, title, raw_text, JSON.stringify(fullSummaryData)],
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
app.put("/api/lectures/:id", lectureFileUpload.array("files", 10), requireAuth, (req, res) => {
    const lectureId = req.params.id;
    const user_id = req.user.user_id;
    const { title, raw_text, summary_data } = req.body;

    if (!title || !raw_text || !summary_data) {
        return res.status(400).json({ message: "필수값이 누락되었습니다." });
    }

    let parsedSummaryData = {};
    try {
        parsedSummaryData =
            typeof summary_data === "string"
                ? JSON.parse(summary_data)
                : summary_data;
    } catch {
        parsedSummaryData = {};
    }

    const uploadedFiles = (req.files || []).map((file) => ({
        originalName: file.originalname,
        filename: file.filename,
        path: `/lecture_uploads/${file.filename}`,
        mimetype: file.mimetype,
    }));

    const nextSummaryData = {
        ...parsedSummaryData,
        files: [
            ...(Array.isArray(parsedSummaryData.files) ? parsedSummaryData.files : []),
            ...uploadedFiles,
        ],
    };

    const sql = `UPDATE lectures SET title = ?, raw_text = ?, summary_data = ? WHERE id = ? AND user_id = ?`;

    db.query(sql, [title, raw_text, JSON.stringify(nextSummaryData), lectureId, user_id], (err, result) => {
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
app.post("/api/quiz-history", requireAuth, (req, res) => {
    const user_id = req.user.user_id;
    const { lecture_id, lecture_title, score, correct, total, results } = req.body;

    if (score === undefined) {
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
app.delete("/api/quiz-history/:historyId", requireAuth, (req, res) => {
    const historyId = req.params.historyId;
    const user_id = req.user.user_id;

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
app.get("/api/quiz-history/:userId", requireAuth, (req, res) => {
    const requestedUserId = String(req.params.userId);
    const tokenUserId = String(req.user.user_id);

    if (requestedUserId !== tokenUserId) {
        return res.status(403).json({ message: "접근 권한이 없습니다." });
    }

    const sql = `SELECT * FROM quiz_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`;

    db.query(sql, [tokenUserId], (err, results) => {
        if (err) {
            console.error("퀴즈 히스토리 조회 오류:", err);
            return res.status(500).json({ message: "히스토리 조회 실패" });
        }
        return res.status(200).json(results);
    });
});

// 강의 삭제
app.delete("/api/lectures/:lectureId", requireAuth, (req, res) => {
    const lectureId = req.params.lectureId;
    const user_id = req.user.user_id;

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
app.get("/api/lectures/:userId", requireAuth, (req, res) => {
    const requestedUserId = String(req.params.userId);
    const sessionUserId = String(req.user.user_id);

    if (requestedUserId !== sessionUserId) {
        return res.status(403).json({ message: "접근 권한이 없습니다." });
    }

    const sql = `SELECT * FROM lectures WHERE user_id = ? ORDER BY created_at DESC`;

    db.query(sql, [sessionUserId], (err, results) => {
        if (err) {
            console.error("불러오기 에러:", err);
            return res.status(500).json({ message: "데이터 불러오기 실패" });
        }

        return res.status(200).json(results);
    });
});

// 로그인 사용자 확인용
app.get("/api/me", requireAuth, (req, res) => {
    return res.status(200).json({
        user: {
            user_id: req.user.user_id,
            name: req.user.name,
            email: req.user.email,
            icon: req.user.icon || "👽",
        },
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

app.post("/api/transcribe", requireAuth, upload.single("audio"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "오디오 파일이 없습니다." });
    }

    const tmpPath = req.file.path;
    // wav로 변환할 경로
    const wavPath = `${tmpPath}.wav`;


    try {
        await convertToWav(tmpPath, wavPath);

        if (!process.env.GROQ_API_KEY) {
            throw new Error("GROQ_API_KEY가 설정되지 않았습니다.");
        }

        if (req.file.size < 4000) {
            return res.status(200).json({ text: "" });
        }

        const wavStat = fs.statSync(wavPath);
        const userId = req.body.userId || req.query.userId || "default";

        const formData = new FormData();
        formData.append("file", fs.createReadStream(wavPath), {
            filename: "audio.wav",         // wav로 고정
            contentType: "audio/wav",      // contentType도 wav로
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
        } catch {
            throw new Error("Whisper 응답 파싱에 실패했습니다.");
        }

        let text = "";
        if (Array.isArray(parsed.segments)) {
            text = parsed.segments
                .filter((seg) => {
                    const isClear = (seg.avg_logprob ?? -1) > -0.8;
                    const isSpeech = (seg.no_speech_prob ?? 1) < 0.4;
                    return isClear && isSpeech;
                })
                .map((seg) => String(seg.text || "").trim())
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
        } else {
            text = String(parsed.text || "").replace(/\s+/g, " ").trim();
        }

        text = text.replace(/(.{4,15}?)( \1){1,}/g, "$1");
        text = text.replace(/(감사합니다\.?|안녕하세요\.?|시청해주셔서 감사합니다\.?)/g, (match) => {
            return text.trim() === match.trim() ? "" : match;
        });

        if (text.length < 5 && (text.includes("감사") || text.includes("안녕"))) {
            text = "";
        }

        const noSpeechProb = parsed.segments?.[0]?.no_speech_prob ?? 1;
        if (noSpeechProb > 0.5) {
            const garbagePatterns = [
                /^안녕하세요[.! ]*$/u,
                /^감사합니다[.! ]*$/u,
                /^(감사합니다[.! ]*){2,}$/u,
                /^(안녕하세요[.! ]*){2,}$/u,
            ];
            if (garbagePatterns.some((p) => p.test(text))) text = "";
        }

        const bannedPhrases = [
            "한국어 강의를 정확히 전사하세요.",
            "이 음성은 학교 강의입니다.",
        ];
        if (bannedPhrases.some((phrase) => text.includes(phrase))) text = "";

        return res.status(200).json({ text });
    } catch (error) {
        console.error("/api/transcribe 오류:", error);
        return res.status(500).json({
            message: error.message || "음성 변환 중 서버 오류가 발생했습니다.",
        });
    } finally {
        try {
            if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        } catch (e) {
            console.error("tmp 파일 삭제 실패:", e);
        }
    }
});

// 퀴즈 채점 - GPT
app.post("/api/grade", requireAuth, async (req, res) => {
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
app.post("/api/summarize", requireAuth, async (req, res) => {
    const { text, quizCount = 3, quizDifficulty = "보통", quizTypes = ["short"] } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: "텍스트가 없습니다." });

    // 난이도별 프롬프트 지시
    const difficultyGuide = {
        "쉬움": "기본 개념을 확인하는 쉬운 문제. 강의에서 직접 언급된 핵심 내용만 묻는다.",
        "보통": "개념의 이해와 적용을 묻는 중간 난이도. 단순 암기가 아닌 이해를 확인한다.",
        "어려움": "심화 개념, 비교·분석·추론을 요구하는 어려운 문제. 강의 내용을 깊이 이해해야 풀 수 있다."
    };

    // 유형별 예시 생성
    const typeExamples = [];
    const hasShort = quizTypes.includes("short");
    const hasMcq = quizTypes.includes("mcq");
    const hasOx = quizTypes.includes("ox");

    if (hasShort) typeExamples.push(`{ "type": "short", "question": "단답형 문제", "answer": "정답" }`);
    if (hasMcq) typeExamples.push(`{ "type": "mcq", "question": "객관식 문제", "choices": ["①보기1", "②보기2", "③보기3", "④보기4"], "answer": "①보기1" }`);
    if (hasOx) typeExamples.push(`{ "type": "ox", "question": "OX로 답할 수 있는 문장형 문제", "answer": "O" }`);

    let typeInstruction = "";
    if (quizTypes.length === 1) {
        const typeNames = { short: "단답형", mcq: "객관식(4지선다)", ox: "OX" };
        typeInstruction = `모든 문제를 ${typeNames[quizTypes[0]]} 유형으로만 만들어라.`;
    } else {
        typeInstruction = `문제 유형을 아래 유형들 사이에서 골고루 섞어라: ${quizTypes.map(t => ({ short: "단답형", mcq: "객관식", ox: "OX" }[t])).join(", ")}.`;
    }

    try {
        const prompt = `
다음 강의 내용을 분석해서 반드시 JSON 형식으로만 응답해.

설명 문장 절대 쓰지 말고 JSON만 반환해.

중요:
- keywords 배열에는 실제 핵심 키워드만 넣어라.
- keywordExplanations의 key는 반드시 keywords 배열에 들어간 실제 키워드 문자열과 완전히 같아야 한다.
- "키워드1", "키워드2" 같은 임시 이름은 절대 사용하지 마라.

퀴즈 조건:
- 문제 수: 정확히 ${quizCount}개
- 난이도: ${quizDifficulty} → ${difficultyGuide[quizDifficulty] || difficultyGuide["보통"]}
- 유형: ${typeInstruction}
- 객관식(mcq) 보기는 반드시 4개, 정답은 보기 중 하나와 정확히 일치해야 함
- OX 문제 정답은 반드시 "O" 또는 "X" 중 하나

예시 구조:
{
  "summary": "한국어 요약 3~5문장",
  "keywords": ["위대한 개츠비", "아메리칸 드림", "인간의 욕망"],
  "keywordExplanations": {
    "위대한 개츠비": "피츠제럴드의 소설로 인간의 욕망과 이상을 다룬 작품이다.",
    "아메리칸 드림": "노력하면 누구나 성공할 수 있다는 미국 사회의 이상이다.",
    "인간의 욕망": "더 나은 삶과 성공을 추구하는 인간의 본성이다."
  },
  "quiz": [
    ${typeExamples.join(",\n    ")}
  ]
}

조건:
- keywords는 3~5개
- keywordExplanations는 반드시 포함
- keywordExplanations의 key는 keywords 배열과 완전히 동일해야 함
- keywords의 모든 항목에 대해 설명 생성 (1:1 대응)
- 하나라도 빠지면 안 됨
- 설명은 쉬운 한국어로 작성
- 강의 맥락 기반 설명

강의 내용:
${text.slice(0, 8000)}
`;

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
                        content: prompt,
                    },
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "GPT 실패");
        }

        const raw = data.choices[0].message.content.trim();

        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error("JSON 파싱 실패");
        }

        const parsed = JSON.parse(match[0]);

        return res.status(200).json(parsed);
    } catch (err) {
        console.error("요약 오류:", err);
        return res.status(500).json({ message: err.message || "요약 오류" });
    }
});

app.post("/api/translate-summarize", requireAuth, async (req, res) => {
    const { text, sourceLang, quizCount = 3, quizDifficulty = "보통", quizTypes = ["short"] } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: "텍스트가 없습니다." });

    const difficultyGuide = {
        "쉬움": "기본 개념을 확인하는 쉬운 문제. 강의에서 직접 언급된 핵심 내용만 묻는다.",
        "보통": "개념의 이해와 적용을 묻는 중간 난이도. 단순 암기가 아닌 이해를 확인한다.",
        "어려움": "심화 개념, 비교·분석·추론을 요구하는 어려운 문제. 강의 내용을 깊이 이해해야 풀 수 있다."
    };

    const typeExamples = [];
    const hasShort = quizTypes.includes("short");
    const hasMcq = quizTypes.includes("mcq");
    const hasOx = quizTypes.includes("ox");

    if (hasShort) typeExamples.push(`{ "type": "short", "question": "단답형 문제", "answer": "정답" }`);
    if (hasMcq) typeExamples.push(`{ "type": "mcq", "question": "객관식 문제", "choices": ["①보기1", "②보기2", "③보기3", "④보기4"], "answer": "①보기1" }`);
    if (hasOx) typeExamples.push(`{ "type": "ox", "question": "OX로 답할 수 있는 문장형 문제", "answer": "O" }`);

    let typeInstruction = "";
    if (quizTypes.length === 1) {
        const typeNames = { short: "단답형", mcq: "객관식(4지선다)", ox: "OX" };
        typeInstruction = `모든 문제를 ${typeNames[quizTypes[0]]} 유형으로만 만들어라.`;
    } else {
        typeInstruction = `문제 유형을 아래 유형들 사이에서 골고루 섞어라: ${quizTypes.map(t => ({ short: "단답형", mcq: "객관식", ox: "OX" }[t])).join(", ")}.`;
    }

    try {
        const prompt = `
다음 강의 내용을 분석해서 반드시 JSON 형식으로만 응답해.

설명 문장 절대 쓰지 말고 JSON만 반환해.

중요:
- keywords 배열에는 실제 핵심 키워드만 넣어라.
- keywordExplanations의 key는 반드시 keywords 배열에 들어간 실제 키워드 문자열과 완전히 같아야 한다.
- "키워드1", "키워드2" 같은 임시 이름은 절대 사용하지 마라.

퀴즈 조건:
- 문제 수: 정확히 ${quizCount}개
- 난이도: ${quizDifficulty} → ${difficultyGuide[quizDifficulty] || difficultyGuide["보통"]}
- 유형: ${typeInstruction}
- 객관식(mcq) 보기는 반드시 4개, 정답은 보기 중 하나와 정확히 일치해야 함
- OX 문제 정답은 반드시 "O" 또는 "X" 중 하나

예시 구조:
{
  "translatedText": "전체 한국어 번역",
  "summary": "한국어 요약 3~5문장",
  "keywords": ["위대한 개츠비", "아메리칸 드림", "인간의 욕망"],
  "keywordExplanations": {
    "위대한 개츠비": "피츠제럴드의 소설로, 부와 사랑 그리고 이상을 좇는 인간의 모습을 보여주는 작품이다.",
    "아메리칸 드림": "노력하면 누구나 성공할 수 있다는 미국 사회의 이상을 뜻한다.",
    "인간의 욕망": "사람이 더 나은 삶이나 성공, 사랑 등을 얻고 싶어 하는 마음을 뜻한다."
  },
  "quiz": [
    ${typeExamples.join(",\n    ")}
  ]
}

조건:
- keywords는 3~5개
- keywordExplanations는 반드시 포함
- keywordExplanations의 모든 key는 keywords 배열의 값과 완전히 동일해야 함
- keywords의 모든 항목에 대해 설명을 만들어라
- 하나라도 빠지면 안 됨
- 설명은 반드시 쉬운 한국어로 작성
- 강의 맥락 기반 설명

강의 내용:
${text.slice(0, 8000)}
`;

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
                        content: prompt,
                    },
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "GPT 실패");
        }

        const raw = data.choices[0].message.content.trim();

        // JSON 추출
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error("JSON 파싱 실패");
        }

        const parsed = JSON.parse(match[0]);

        return res.status(200).json(parsed);
    } catch (err) {
        console.error("요약 오류:", err);
        return res.status(500).json({ message: err.message || "요약 오류" });
    }
});

// 퀴즈 전용 생성 API (요약과 분리)
app.post("/api/generate-quiz", requireAuth, async (req, res) => {
    const { text, quizCount = 3, quizDifficulty = "보통", quizTypes = ["short"] } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: "텍스트가 없습니다." });

    const difficultyGuide = {
        "쉬움": "강의에서 직접 언급된 핵심 사실만 묻는 쉬운 문제를 만들어라. 답이 명확하고 짧아야 한다.",
        "보통": "개념의 이해와 적용을 묻는 중간 난이도 문제를 만들어라.",
        "어려움": "심화 개념, 비교·분석·추론이 필요한 어려운 문제를 만들어라."
    };

    const typeNames = { short: "단답형", mcq: "객관식(4지선다)", ox: "OX" };
    const allowedTypes = quizTypes.map(t => typeNames[t] || t).join(", ");

    // 유형별 JSON 예시 생성
    const buildTypeExamples = () => {
        const ex = [];
        if (quizTypes.includes("short")) ex.push(`{ "type": "short", "question": "단답형 질문", "answer": "정답" }`);
        if (quizTypes.includes("mcq")) ex.push(`{ "type": "mcq", "question": "객관식 질문", "choices": ["①보기1", "②보기2", "③보기3", "④보기4"], "answer": "①보기1" }`);
        if (quizTypes.includes("ox")) ex.push(`{ "type": "ox", "question": "OX 판단 문장", "answer": "O" }`);
        return ex.join(",\n    ");
    };

    const prompt = `
다음 강의 내용을 바탕으로 퀴즈를 생성해라.
반드시 JSON 배열만 반환해라. 설명, 주석, 마크다운 없이 순수 JSON 배열만.

조건:
- 문제 수: 정확히 ${quizCount}개
- 난이도: ${quizDifficulty} → ${difficultyGuide[quizDifficulty]}
- 허용 유형: 반드시 [${allowedTypes}] 중에서만 출제하라. 다른 유형은 절대 사용 금지.
- 유형이 여러 개면 고르게 섞어라.
- 객관식 보기는 정확히 4개, 정답은 보기 중 하나와 완전히 동일해야 함.
- OX 정답은 반드시 "O" 또는 "X" 중 하나.

출력 형식 (JSON 배열, 다른 텍스트 없음):
[
    ${buildTypeExamples()}
]

강의 내용:
${text.slice(0, 8000)}
`;

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
            }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "GPT 실패");

        const raw = data.choices[0].message.content.trim();
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) throw new Error("JSON 파싱 실패");

        const quiz = JSON.parse(match[0]);
        return res.status(200).json({ quiz });
    } catch (err) {
        console.error("퀴즈 생성 오류:", err);
        return res.status(500).json({ message: err.message || "퀴즈 생성 오류" });
    }
});



server.listen(PORT, () => {
    console.log(`✅ 서버 실행 중: ${PORT}`);
});