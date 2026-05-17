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
const pdfParse = require("pdf-parse");
const AdmZip = require("adm-zip");
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
function fixOriginalName(name) {
    if (!name) return "첨부파일";

    try {
        return Buffer.from(name, "latin1").toString("utf8");
    } catch {
        return name;
    }
}

function stripXmlTags(xml) {
    return String(xml || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function extractZipOfficeText(filePath, patterns) {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    return entries
        .filter((entry) => patterns.some((pattern) => pattern.test(entry.entryName)))
        .map((entry) => stripXmlTags(entry.getData().toString("utf8")))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
}

async function extractImageTextWithOpenAI(filePath, mimetype) {
    const imageBase64 = fs.readFileSync(filePath).toString("base64");

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
                    content: [
                        {
                            type: "text",
                            text: "이 이미지는 강의자료입니다. 이미지 안의 텍스트와 핵심 내용을 한국어로 자세히 추출해줘.",
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimetype};base64,${imageBase64}`,
                            },
                        },
                    ],
                },
            ],
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error?.message || "이미지 분석 실패");
    }

    return data.choices?.[0]?.message?.content || "";
}

async function extractLectureFileText(file) {
    const filePath = file.path;
    const originalName = fixOriginalName(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const mimetype = file.mimetype || "";

    try {
        if (ext === ".pdf" || mimetype.includes("pdf")) {
            const buffer = fs.readFileSync(filePath);
            const parsed = await pdfParse(buffer);
            const pdfText = String(parsed.text || "")
                .replace(/\uFFFE/g, " ")
                .replace(/[^\S\r\n]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            if (pdfText.length >= 80) {
                return pdfText;
            }

            return "[PDF 텍스트 추출이 충분하지 않습니다. 이 PDF는 스캔본이거나 특수 폰트 PDF일 수 있습니다. 텍스트가 선택 가능한 PDF 또는 PPTX/DOCX로 변환해 업로드하면 더 정확합니다.]";
        }

        if (ext === ".pptx") {
            return extractZipOfficeText(filePath, [/^ppt\/slides\/slide\d+\.xml$/]);
        }

        if (ext === ".docx") {
            return extractZipOfficeText(filePath, [/^word\/document\.xml$/]);
        }

        if (ext === ".hwpx") {
            return extractZipOfficeText(filePath, [/^Contents\/section\d+\.xml$/]);
        }

        if ([".txt", ".md", ".csv"].includes(ext)) {
            return fs.readFileSync(filePath, "utf8");
        }

        if (mimetype.startsWith("image/")) {
            return await extractImageTextWithOpenAI(filePath, mimetype);
        }

        if (ext === ".hwp") {
            return "[.hwp 파일은 바로 읽기 어렵습니다. 가능하면 .hwpx 또는 PDF로 변환해서 업로드해주세요.]";
        }

        return "";
    } catch (err) {
        console.error(`${originalName} 내용 추출 실패:`, err);
        return "";
    }
}

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
// lecture_uploads에 저장된 실제 파일들을 디스크에서 삭제
function deleteLectureFiles(summaryData) {
    let parsed = {};
    try {
        parsed = typeof summaryData === "string" ? JSON.parse(summaryData) : summaryData || {};
    } catch {
        return;
    }

    const files = Array.isArray(parsed.files) ? parsed.files : [];
    for (const file of files) {
        const filename = file?.filename;
        if (!filename) continue;

        // filename이 "lecture_uploads/xxx" 형태이거나 파일명만 있는 경우 모두 처리
        const filePath = filename.startsWith("lecture_uploads/")
            ? filename
            : path.join(lectureUploadDir, filename);

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️  파일 삭제: ${filePath}`);
            }
        } catch (e) {
            console.error(`파일 삭제 실패 (${filePath}):`, e.message);
        }
    }
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
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch {
        return res.status(401).json({ message: "토큰 오류" });
    }
}

// ─── 관리자 전용 미들웨어 ───────────────────────────────────────────
function requireAdmin(req, res, next) {
    const auth = req.headers.authorization || "";
    const token = auth.split(" ")[1];
    if (!token) return res.status(401).json({ message: "인증 필요" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.is_admin) return res.status(403).json({ message: "관리자 권한이 필요합니다." });
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

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

app.post("/api/ai-chat", requireAuth, async (req, res) => {
    try {
        const { messages, lectureContext } = req.body;

        const systemPrompt = lectureContext
            ? `너는 강의 내용을 바탕으로 답변하는 한국어 AI 튜터야.

아래 강의 내용을 참고해서 사용자의 질문에 답변해.

${lectureContext}`
            : "너는 친절한 한국어 AI 튜터야. 사용자의 질문에 쉽고 정확하게 답변해.";

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    ...(Array.isArray(messages) ? messages : []),
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                message: data.error?.message || "AI 응답 생성 실패",
            });
        }

        return res.status(200).json({
            answer: data.choices?.[0]?.message?.content || "답변을 생성하지 못했습니다.",
        });
    } catch (err) {
        console.error("AI 질문 오류:", err);
        return res.status(500).json({
            message: err.message || "AI 질문 처리 중 오류가 발생했습니다.",
        });
    }
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

// 단체 채팅방 나가기 (멤버에서 삭제)
app.delete("/api/chat/rooms/leave", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const { roomId } = req.body;

    if (!roomId) return res.status(400).json({ message: "roomId가 필요합니다." });

    // 1. 해당 방의 멤버에서 나를 삭제
    db.query(
        "DELETE FROM room_members WHERE room_id = ? AND user_id = ?",
        [roomId, userId],
        (err, result) => {
            if (err) {
                console.error("방 나가기 DB 에러:", err);
                return res.status(500).json({ message: "방 나가기 실패" });
            }

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: "해당 방의 멤버가 아니거나 방을 찾을 수 없습니다." });
            }

            // 2. 방에 남은 멤버가 있는지 확인 (선택 사항: 멤버가 0명이면 방 자체를 삭제 가능)
            db.query("SELECT COUNT(*) as count FROM room_members WHERE room_id = ?", [roomId], (countErr, countRows) => {
                if (!countErr && countRows[0].count === 0) {
                    // 메시지와 방 정보 삭제
                    db.query("DELETE FROM chat_messages WHERE room_id = ?", [roomId]);
                    db.query("DELETE FROM chat_rooms WHERE room_id = ?", [roomId]);
                }
            });

            return res.status(200).json({ message: "채팅방에서 성공적으로 나갔습니다." });
        }
    );
});

// 사용자의 폴더 목록 조회
app.get("/api/folders", requireAuth, (req, res) => {
    const userId = req.user.user_id;

    const sql = `
        SELECT 
            f.id,
            f.name,
            COUNT(l.id) AS lecture_count
        FROM folders f
        LEFT JOIN lectures l
            ON l.user_id = f.user_id
           AND l.folder_name = f.name
        WHERE f.user_id = ?
        GROUP BY f.id, f.name
        ORDER BY f.name ASC
    `;

    db.query(sql, [userId], (err, results) => {
        if (err) {
            console.error("폴더 조회 실패:", err);
            return res.status(500).json({ message: "폴더 조회 실패" });
        }

        return res.status(200).json(results);
    });
});

// 새 폴더 생성
app.post("/api/folders", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const name = String(req.body.name || "").trim();

    if (!name) {
        return res.status(400).json({ message: "폴더 이름이 필요합니다." });
    }

    const sql = `
        INSERT INTO folders (user_id, name)
        VALUES (?, ?)
    `;

    db.query(sql, [userId, name], (err, result) => {
        if (err) {
            if (err.code === "ER_DUP_ENTRY") {
                return res.status(409).json({ message: "이미 같은 이름의 폴더가 있습니다." });
            }

            console.error("폴더 생성 실패:", err);
            return res.status(500).json({ message: "폴더 생성 실패" });
        }

        return res.status(201).json({
            id: result.insertId,
            name,
            lecture_count: 0,
        });
    });
});

// 폴더 이름 수정
app.patch("/api/folders/:folderId", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const folderId = req.params.folderId;
    const newName = String(req.body.name || "").trim();

    if (!newName) {
        return res.status(400).json({ message: "새 폴더 이름이 필요합니다." });
    }

    db.query(
        "SELECT id, name FROM folders WHERE id = ? AND user_id = ? LIMIT 1",
        [folderId, userId],
        (findErr, rows) => {
            if (findErr) {
                console.error("폴더 조회 실패:", findErr);
                return res.status(500).json({ message: "폴더 조회 실패" });
            }

            if (rows.length === 0) {
                return res.status(404).json({ message: "폴더를 찾을 수 없습니다." });
            }

            const oldName = rows[0].name;

            db.query(
                "SELECT id FROM folders WHERE user_id = ? AND name = ? AND id != ? LIMIT 1",
                [userId, newName, folderId],
                (dupErr, dupRows) => {
                    if (dupErr) {
                        console.error("폴더 중복 확인 실패:", dupErr);
                        return res.status(500).json({ message: "폴더 중복 확인 실패" });
                    }

                    if (dupRows.length > 0) {
                        return res.status(409).json({ message: "이미 같은 이름의 폴더가 있습니다." });
                    }

                    db.query(
                        "UPDATE folders SET name = ? WHERE id = ? AND user_id = ?",
                        [newName, folderId, userId],
                        (updateErr) => {
                            if (updateErr) {
                                console.error("폴더 이름 수정 실패:", updateErr);
                                return res.status(500).json({ message: "폴더 이름 수정 실패" });
                            }

                            db.query(
                                "UPDATE lectures SET folder_name = ? WHERE user_id = ? AND folder_name = ?",
                                [newName, userId, oldName],
                                (lectureErr) => {
                                    if (lectureErr) {
                                        console.error("강의 폴더명 동기화 실패:", lectureErr);
                                        return res.status(500).json({ message: "강의 폴더명 동기화 실패" });
                                    }

                                    return res.status(200).json({
                                        message: "폴더 이름이 수정되었습니다.",
                                        id: Number(folderId),
                                        oldName,
                                        name: newName,
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

// 폴더 삭제
app.delete("/api/folders/:folderId", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const folderId = req.params.folderId;

    db.query(
        "SELECT id, name FROM folders WHERE id = ? AND user_id = ? LIMIT 1",
        [folderId, userId],
        (findErr, rows) => {
            if (findErr) {
                console.error("폴더 조회 실패:", findErr);
                return res.status(500).json({ message: "폴더 조회 실패" });
            }

            if (rows.length === 0) {
                return res.status(404).json({ message: "폴더를 찾을 수 없습니다." });
            }

            const folderName = rows[0].name;

            // 폴더 삭제 시 강의 자체는 삭제하지 않고, 폴더 연결만 해제
            db.query(
                "UPDATE lectures SET folder_name = NULL WHERE user_id = ? AND folder_name = ?",
                [userId, folderName],
                (lectureErr) => {
                    if (lectureErr) {
                        console.error("강의 폴더 연결 해제 실패:", lectureErr);
                        return res.status(500).json({ message: "강의 폴더 연결 해제 실패" });
                    }

                    db.query(
                        "DELETE FROM folders WHERE id = ? AND user_id = ?",
                        [folderId, userId],
                        (deleteErr) => {
                            if (deleteErr) {
                                console.error("폴더 삭제 실패:", deleteErr);
                                return res.status(500).json({ message: "폴더 삭제 실패" });
                            }

                            return res.status(200).json({
                                message: "폴더가 삭제되었습니다.",
                                deletedFolderName: folderName,
                            });
                        }
                    );
                }
            );
        }
    );
});

// 강의를 폴더에 넣기 또는 폴더에서 빼기
app.put("/api/lectures/:lectureId/folder", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const lectureId = req.params.lectureId;

    // 폴더 선택은 필수가 아님. 빈 값이면 폴더 없음으로 저장.
    const folderName = req.body.folderName ? String(req.body.folderName).trim() : null;

    const updateLectureFolder = () => {
        db.query(
            "UPDATE lectures SET folder_name = ? WHERE id = ? AND user_id = ?",
            [folderName || null, lectureId, userId],
            (err, result) => {
                if (err) {
                    console.error("강의 폴더 변경 실패:", err);
                    return res.status(500).json({ message: "강의 폴더 변경 실패" });
                }

                if (result.affectedRows === 0) {
                    return res.status(404).json({ message: "강의를 찾을 수 없습니다." });
                }

                return res.status(200).json({
                    message: folderName ? "강의를 폴더에 넣었습니다." : "강의를 폴더에서 뺐습니다.",
                    folderName,
                });
            }
        );
    };

    // 폴더 선택 안 함이면 그냥 null 저장
    if (!folderName) {
        return updateLectureFolder();
    }

    // 폴더 선택했으면 내 폴더인지 확인
    db.query(
        "SELECT id FROM folders WHERE user_id = ? AND name = ? LIMIT 1",
        [userId, folderName],
        (folderErr, folderRows) => {
            if (folderErr) {
                console.error("폴더 확인 실패:", folderErr);
                return res.status(500).json({ message: "폴더 확인 실패" });
            }

            if (folderRows.length === 0) {
                return res.status(404).json({ message: "존재하지 않는 폴더입니다." });
            }

            updateLectureFolder();
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

// 친구 삭제 API
app.delete("/api/friends/:friendId", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const friendId = req.params.friendId;

    if (String(userId) === String(friendId)) {
        return res.status(400).json({ message: "자기 자신은 삭제할 수 없습니다." });
    }

    // 양방향 레코드 모두 삭제 (A→B, B→A)
    db.query(
        "DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
        [userId, friendId, friendId, userId],
        (err, result) => {
            if (err) {
                console.error("친구 삭제 오류:", err);
                return res.status(500).json({ message: "친구 삭제 실패" });
            }
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: "친구 관계를 찾을 수 없습니다." });
            }
            return res.status(200).json({ message: "친구가 삭제되었습니다." });
        }
    );
});


function emitBoardToFriendsAndSelf(ownerId, eventName, payload) {
    io.to(`user_${ownerId}`).emit(eventName, payload);

    db.query(
        `
        SELECT CASE
            WHEN user_id = ? THEN friend_id
            ELSE user_id
        END AS friend_id
        FROM friends
        WHERE (user_id = ? OR friend_id = ?)
          AND status = 'accepted'
        `,
        [ownerId, ownerId, ownerId],
        (err, rows) => {
            if (err) {
                console.error("보드 친구 조회 실패:", err);
                return;
            }

            rows.forEach((row) => {
                io.to(`user_${row.friend_id}`).emit(eventName, payload);
            });
        }
    );
}

app.get("/api/board/items", requireAuth, (req, res) => {
    const userId = req.user.user_id;

    const sql = `
        SELECT bi.*
        FROM board_items bi
        WHERE bi.owner_id = ?
           OR bi.owner_id IN (
                SELECT CASE
                    WHEN user_id = ? THEN friend_id
                    ELSE user_id
                END
                FROM friends
                WHERE (user_id = ? OR friend_id = ?)
                  AND status = 'accepted'
           )
        ORDER BY bi.created_at ASC
    `;

    db.query(sql, [userId, userId, userId, userId], (err, rows) => {
        if (err) {
            console.error("보드 목록 조회 실패:", err);
            return res.status(500).json({ message: "보드 목록 조회 실패" });
        }

        const items = rows.map((row) => ({
            id: row.id,
            owner_id: row.owner_id,
            item_type: row.item_type,
            data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }));

        res.json(items);
    });
});

app.post("/api/board/items", requireAuth, (req, res) => {
    const ownerId = req.user.user_id;
    const { id, item_type, data } = req.body;

    if (!id || !item_type || !data) {
        return res.status(400).json({ message: "보드 데이터가 부족합니다." });
    }

    const sql = `
        INSERT INTO board_items (id, owner_id, item_type, data)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE data = VALUES(data)
    `;

    db.query(sql, [id, ownerId, item_type, JSON.stringify(data)], (err) => {
        if (err) {
            console.error("보드 저장 실패:", err);
            return res.status(500).json({ message: "보드 저장 실패" });
        }

        const payload = { id, owner_id: ownerId, item_type, data };
        emitBoardToFriendsAndSelf(ownerId, "board_item_saved", payload);

        res.json(payload);
    });
});

app.delete("/api/board/items", requireAuth, (req, res) => {
    const ownerId = req.user.user_id;

    db.query(
        "DELETE FROM board_items WHERE owner_id = ?",
        [ownerId],
        (err) => {
            if (err) {
                console.error("보드 전체 삭제 실패:", err);
                return res.status(500).json({ message: "보드 전체 삭제 실패" });
            }

            emitBoardToFriendsAndSelf(ownerId, "board_cleared", {
                owner_id: ownerId,
            });

            res.json({ message: "보드 전체 삭제 완료" });
        }
    );
});

app.delete("/api/board/items/:id", requireAuth, (req, res) => {
    const ownerId = req.user.user_id;
    const itemId = req.params.id;

    db.query(
        "DELETE FROM board_items WHERE id = ? AND owner_id = ?",
        [itemId, ownerId],
        (err, result) => {
            if (err) {
                console.error("보드 삭제 실패:", err);
                return res.status(500).json({ message: "보드 삭제 실패" });
            }

            if (result.affectedRows === 0) {
                return res.status(403).json({ message: "삭제 권한이 없습니다." });
            }

            emitBoardToFriendsAndSelf(ownerId, "board_item_deleted", {
                id: itemId,
                owner_id: ownerId,
            });

            res.json({ message: "삭제되었습니다." });
        }
    );
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

//1. 회원가입 api
app.post("/api/signup", async (req, res) => {
    const { name, email, password } = req.body;

    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanName || !cleanEmail || !cleanPassword) {
        return res.status(400).json({ message: "이름, 이메일, 비밀번호를 입력해주세요." });
    }

    try {
        const hashedPassword = await bcrypt.hash(cleanPassword, 10);
        const verificationToken = crypto.randomBytes(32).toString("hex");
        const verifyUrl = `${process.env.BACKEND_URL || "http://localhost:5000"}/api/verify-email?token=${verificationToken}`;

        const sendVerificationMail = () => {
            const transporter = gmailTransporter;

            const mailOptions = {
                from: `Lecture AI <${process.env.GMAIL_USER}>`,
                to: cleanEmail,
                subject: "[Lecture AI] 이메일 인증을 완료해주세요",
                html: `
                    <div style="background:#f9fafb;padding:40px;font-family:sans-serif;">
                        <div style="max-width:500px;margin:0 auto;background:white;padding:24px;border-radius:12px;border:1px solid #eee;">
                            <h2 style="color:#2383e2;">Lecture AI 이메일 인증</h2>
                            <p>아래 버튼을 눌러 이메일 인증을 완료해주세요.</p>
                            <a href="${verifyUrl}" style="display:inline-block;margin-top:16px;padding:12px 18px;background:#2383e2;color:white;text-decoration:none;border-radius:8px;">
                                이메일 인증하기
                            </a>
                            <p style="margin-top:20px;color:#666;font-size:13px;">
                                버튼이 안 눌리면 아래 링크를 복사해서 브라우저에 붙여넣어 주세요.<br/>
                                ${verifyUrl}
                            </p>
                        </div>
                    </div>
                `,
            };

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) {
                    console.error("메일 발송 실패:", mailErr);
                    return res.status(500).json({
                        message: "메일 발송에 실패했습니다. 백엔드 터미널의 메일 발송 실패 로그를 확인해주세요.",
                    });
                }

                return res.status(200).json({
                    message: "📩 인증 메일이 발송되었습니다! 메일함을 확인해주세요.",
                });
            });
        };

        db.query(
            "SELECT user_id, is_verified FROM users WHERE email = ? LIMIT 1",
            [cleanEmail],
            (findErr, rows) => {
                if (findErr) {
                    console.error("회원 조회 실패:", findErr);
                    return res.status(500).json({ message: "회원 조회 실패" });
                }

                if (rows.length > 0) {
                    const existingUser = rows[0];

                    if (existingUser.is_verified) {
                        return res.status(400).json({ message: "이미 사용 중인 이메일입니다." });
                    }

                    db.query(
                        `
                        UPDATE users
                        SET name = ?,
                            password = ?,
                            verification_token = ?,
                            is_verified = false
                        WHERE email = ?
                        `,
                        [cleanName, hashedPassword, verificationToken, cleanEmail],
                        (updateErr) => {
                            if (updateErr) {
                                console.error("미인증 계정 갱신 실패:", updateErr);
                                return res.status(500).json({ message: "회원가입 정보 갱신 실패" });
                            }

                            sendVerificationMail();
                        }
                    );

                    return;
                }

                db.query(
                    `
                    INSERT INTO users
                        (name, email, password, verification_token, is_verified)
                    VALUES (?, ?, ?, ?, false)
                    `,
                    [cleanName, cleanEmail, hashedPassword, verificationToken],
                    (insertErr) => {
                        if (insertErr) {
                            console.error("회원가입 DB 저장 실패:", insertErr);
                            return res.status(400).json({ message: "회원가입 실패" });
                        }

                        sendVerificationMail();
                    }
                );
            }
        );
    } catch (err) {
        console.error("회원가입 처리 실패:", err);
        return res.status(500).json({ message: "회원가입 처리 중 오류가 발생했습니다." });
    }
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

        const safeUser = {
            user_id: user.user_id,
            name: user.name,
            email: user.email,
            is_admin: !!user.is_admin,
        };
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

    // 폴더 선택은 필수가 아님
    const folderName = req.body.folderName ? String(req.body.folderName).trim() : null;

    const files = (req.files || []).map((file) => ({
        originalName: fixOriginalName(file.originalname),
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

    const saveLecture = () => {
        const sql = `
            INSERT INTO lectures 
                (user_id, title, raw_text, summary_data, folder_name) 
            VALUES (?, ?, ?, ?, ?)
        `;

        db.query(
            sql,
            [user_id, title, raw_text, JSON.stringify(fullSummaryData), folderName || null],
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
    };

    // 폴더를 선택하지 않았으면 바로 저장
    if (!folderName) {
        return saveLecture();
    }

    // 폴더를 선택했으면 내 폴더인지 확인 후 저장
    db.query(
        "SELECT id FROM folders WHERE user_id = ? AND name = ? LIMIT 1",
        [user_id, folderName],
        (folderErr, folderRows) => {
            if (folderErr) {
                console.error("폴더 확인 실패:", folderErr);
                return res.status(500).json({ message: "폴더 확인 실패" });
            }

            if (folderRows.length === 0) {
                return res.status(404).json({ message: "존재하지 않는 폴더입니다." });
            }

            saveLecture();
        }
    );
});

// 강의 수정
app.put("/api/lectures/:id", requireAuth, lectureFileUpload.array("files", 10), (req, res) => {
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
        originalName: fixOriginalName(file.originalname),
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

    // 파일 경로 먼저 조회 → 퀴즈 히스토리 → 강의 순으로 삭제
    db.query("SELECT summary_data FROM lectures WHERE id = ? AND user_id = ?", [lectureId, user_id], (findErr, rows) => {
        if (findErr) {
            console.error("강의 조회 오류:", findErr);
            return res.status(500).json({ message: "강의 조회 실패" });
        }
        if (rows.length === 0) {
            return res.status(404).json({ message: "강의를 찾을 수 없거나 권한이 없습니다." });
        }

        // 실제 파일 삭제 (없는 파일은 조용히 스킵)
        deleteLectureFiles(rows[0].summary_data);

        db.query("DELETE FROM quiz_history WHERE lecture_id = ? AND user_id = ?", [lectureId, user_id], (quizErr) => {
            if (quizErr) {
                console.error("퀴즈 히스토리 삭제 오류:", quizErr);
                return res.status(500).json({ message: "연결된 퀴즈 기록 삭제 실패" });
            }

            db.query("DELETE FROM lectures WHERE id = ? AND user_id = ?", [lectureId, user_id], (err, result) => {
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

        const wavStat = fs.statSync(wavPath);
        if (wavStat.size < 8000) return res.status(200).json({ text: "" });

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
app.post("/api/summarize", requireAuth, lectureFileUpload.array("files", 10), async (req, res) => {
    const { text = "", quizCount = 3, quizDifficulty = "보통" } = req.body;

    let quizTypes = req.body.quizTypes || ["short"];
    if (typeof quizTypes === "string") {
        try {
            quizTypes = JSON.parse(quizTypes);
        } catch {
            quizTypes = [quizTypes];
        }
    }
    if (!Array.isArray(quizTypes)) quizTypes = ["short"];

    const extractedParts = [];

for (const file of req.files || []) {
    const originalName = fixOriginalName(file.originalname);
    const extractedText = await extractLectureFileText(file);

    if (String(extractedText || "").trim()) {
        extractedParts.push(`파일명: ${originalName}\n${extractedText}`);
    }

    // 요약용 임시 업로드 파일은 저장하지 않고 삭제
    fs.unlink(file.path, () => { });
}

    const normalizedParts = extractedParts
    .map((part, index) => {
        const cleaned = String(part || "").trim();

        if (!cleaned) return "";

        return [
            "==============================",
            `첨부파일 ${index + 1} 추출 내용`,
            "==============================",
            cleaned,
        ].join("\n");
    })
    .filter(Boolean);

const combinedText = [
    String(text || "").trim()
        ? `사용자 입력 내용:\n${String(text || "").trim()}`
        : "",
    ...normalizedParts,
]
    .filter(Boolean)
    .join("\n\n");

    if (!combinedText.trim()) {
        return res.status(400).json({ message: "요약할 텍스트나 파일 내용이 없습니다." });
    }

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

    const summarizeOneFile = async (content, index) => {
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
                    content: `
다음은 첨부파일 ${index + 1}의 강의 원문이다.
중요 개념, 코드, 키워드, 시험 포인트가 빠지지 않게 한국어로 자세히 요약해라.

강의 원문:
${content.slice(0, 24000)}
`,
                },
            ],
            temperature: 0,
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error?.message || `첨부파일 ${index + 1} 요약 실패`);
    }

    return data.choices?.[0]?.message?.content || "";
};

const fileSummaries = [];

for (let i = 0; i < extractedParts.length; i++) {
    const summary = await summarizeOneFile(extractedParts[i], i);
    fileSummaries.push(`첨부파일 ${i + 1} 요약:\n${summary}`);
}

const summarySourceText = [
    String(text || "").trim()
        ? `사용자 입력 내용:\n${String(text || "").trim()}`
        : "",
    fileSummaries.length > 0
        ? `첨부파일별 요약:\n${fileSummaries.join("\n\n")}`
        : "",
]
    .filter(Boolean)
    .join("\n\n");

    try {
        const prompt = `
다음 강의 내용을 분석해서 반드시 JSON 형식으로만 응답해.

설명 문장 절대 쓰지 말고 JSON만 반환해.

먼저 강의 내용을 보고 과목 유형을 자동 분류해라.

subjectType은 아래 중 하나로 고른다:
- "computer_science": 프로그래밍, 알고리즘, 데이터베이스, 네트워크, 운영체제, 소프트웨어 관련
- "math": 수학, 통계, 공식, 증명, 계산, 풀이 중심
- "science": 물리, 화학, 생명, 지구과학, 실험/원리 중심
- "language": 영어, 외국어, 문법, 어휘, 독해 중심
- "humanities": 문학, 역사, 철학, 사회, 교육, 인문/사회 이론 중심
- "business": 경영, 경제, 회계, 마케팅, 재무 중심
- "general": 위 유형에 명확히 속하지 않는 일반 강의

analysisTitle은 사용자가 바로 이해할 수 있는 분석 제목으로 작성해라.

중요:
- 단순 요약만 하지 마라.
- 강의 유형에 맞는 학습 자료를 만들어라.
- computer_science이면 코드, 문법, 실행 흐름, 오류 포인트, 시험 포인트를 중심으로 분석해라.
- math이면 공식, 기호 의미, 풀이 단계, 자주 나오는 문제 유형을 중심으로 분석해라.
- science이면 핵심 원리, 과정, 변수 관계, 실험/현상 해석을 중심으로 분석해라.
- language이면 핵심 표현, 단어, 문법, 해석, 예문을 중심으로 분석해라.
- humanities이면 개념, 주장, 배경, 비교, 사례를 중심으로 분석해라.
- business이면 핵심 개념, 지표, 계산식, 사례, 의사결정 포인트를 중심으로 분석해라.
- keywords 배열에는 실제 핵심 키워드만 넣어라.
- keywordExplanations의 key는 반드시 keywords 배열에 들어간 실제 키워드 문자열과 완전히 같아야 한다.
- "키워드1", "키워드2" 같은 임시 이름은 절대 사용하지 마라.

퀴즈 조건:
- 문제 수: 정확히 ${quizCount}개
- 난이도: ${quizDifficulty} → ${difficultyGuide[quizDifficulty] || difficultyGuide["보통"]}
- 유형: ${typeInstruction}
- 객관식(mcq) 보기는 반드시 4개, 정답은 보기 중 하나와 정확히 일치해야 함
- OX 문제 정답은 반드시 "O" 또는 "X" 중 하나

quiz 배열 규칙:

- 단답형 문제 type은 반드시 "short"
- 객관식 문제 type은 반드시 "mcq"
- OX 문제 type은 반드시 "ox"

객관식 문제는 반드시 아래 형식 사용:

{
  "type": "mcq",
  "question": "...",
  "choices": ["1", "2", "3", "4"],
  "answer": "..."
}

절대로 "options", "보기", "선택지", "객관식", "주관식" 같은 다른 키나 타입명을 사용하지 마라.
응답 JSON 형식:
{
  "subjectType": "computer_science",
  "analysisTitle": "자바 상속과 다형성 핵심 학습",
  "summary": "강의 전체 핵심을 4~7문장으로 정리",
  "keywords": ["키워드1", "키워드2", "키워드3"],
  "keywordExplanations": {
    "키워드1": "쉬운 설명",
    "키워드2": "쉬운 설명",
    "키워드3": "쉬운 설명"
  },
  "studyGuide": {
    "coreConcepts": [
      {
        "title": "핵심 개념명",
        "explanation": "개념 설명",
        "whyImportant": "왜 중요한지"
      }
    ],
    "codeHighlights": [
      {
        "code": "중요 코드 또는 문법",
        "explanation": "코드 의미",
        "flow": "실행 흐름 또는 사용 상황"
      }
    ],
    "formulas": [
      {
        "formula": "공식 또는 기호",
        "meaning": "의미",
        "useCase": "언제 쓰는지"
      }
    ],
    "problemSolvingSteps": [
      "풀이/학습 단계 1",
      "풀이/학습 단계 2"
    ],
    "examPoints": [
      "시험에 나올 핵심 포인트"
    ],
    "commonMistakes": [
      "자주 틀리는 부분"
    ],
    "practiceTasks": [
      "직접 해볼 실습 또는 연습"
    ]
  },
  "quiz": [
    ${typeExamples.join(",\n    ")}
  ]
}


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
- 해당 과목 유형과 관련 없는 배열은 빈 배열 []로 둔다.
  예: 수학 강의면 codeHighlights는 [], 컴공 강의면 formulas는 필요한 경우만 채운다.
- computer_science 강의에서 코드가 나오면 codeHighlights를 반드시 채운다.
- math 강의에서 공식이 나오면 formulas와 problemSolvingSteps를 반드시 채운다.
- 하나라도 빠지면 안 됨
- 설명은 쉬운 한국어로 작성
- 강의 맥락 기반 설명

강의 내용:
${summarySourceText}
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

        let parsed;

try {
    parsed = JSON.parse(match[0]);
} catch (parseErr) {
    console.error("JSON 파싱 실패 원문:", raw);

    const repairedJson = match[0]
        .replace(/\r?\n/g, "\\n")
        .replace(/\t/g, "\\t");

    parsed = JSON.parse(repairedJson);
}

        return res.status(200).json({
            ...parsed,

            // 프론트 화면/저장용 원문은 자르지 않고 전체 반환
            extractedText: combinedText,

            // 디버깅/표시용 파일별 추출 정보
            extractedFiles: extractedParts.map((part) => ({
                text: part,
                length: part.length,
            })),
        });

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
JSON 문자열 안에는 실제 줄바꿈을 넣지 말고 반드시 \\n으로 이스케이프해라.
summary, keywordExplanations, studyGuide의 모든 문자열은 한 줄 문자열로 작성해라.

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

// ─── 전체 유저 목록 조회 ────────────────────────────────────────────
app.get("/api/admin/users", requireAdmin, (req, res) => {
    db.query(
        "SELECT user_id, name, email, is_verified, is_admin, created_at FROM users ORDER BY created_at DESC",
        (err, results) => {
            if (err) return res.status(500).json({ message: "유저 목록 조회 실패" });
            return res.status(200).json(results);
        }
    );
});

// ─── 유저 삭제 (연결 데이터 전체 삭제) ─────────────────────────────
app.delete("/api/admin/users/:userId", requireAdmin, (req, res) => {
    const targetId = req.params.userId;

    if (String(targetId) === String(req.user.user_id)) {
        return res.status(400).json({ message: "자기 자신은 삭제할 수 없습니다." });
    }

    const run = (sql, params) =>
        new Promise((resolve, reject) =>
            db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)))
        );

    (async () => {
        // 1. 퀴즈 히스토리
        await run("DELETE FROM quiz_history WHERE user_id = ?", [targetId]);
        // 2. 강의 파일 디스크 삭제 → DB 삭제
        const lectures = await run("SELECT summary_data FROM lectures WHERE user_id = ?", [targetId]);
        for (const lecture of lectures) {
            deleteLectureFiles(lecture.summary_data);
        }
        await run("DELETE FROM lectures WHERE user_id = ?", [targetId]);
        // 3. 친구 관계
        await run("DELETE FROM friends WHERE user_id = ? OR friend_id = ?", [targetId, targetId]);
        // 4. 채팅 메시지 (보낸 메시지)
        await run("DELETE FROM chat_messages WHERE sender_id = ?", [targetId]);
        // 5. 채팅방 멤버
        await run("DELETE FROM room_members WHERE user_id = ?", [targetId]);
        // 6. 유저 삭제
        const result = await run("DELETE FROM users WHERE user_id = ?", [targetId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "유저를 찾을 수 없습니다." });
        }
        return res.status(200).json({ message: "유저가 삭제되었습니다." });
    })().catch((err) => {
        console.error("유저 삭제 오류:", err);
        return res.status(500).json({ message: "유저 삭제 중 오류가 발생했습니다." });
    });
});

// ─── 유저 admin 권한 토글 ──────────────────────────────────────────
app.patch("/api/admin/users/:userId/toggle-admin", requireAdmin, (req, res) => {
    const targetId = req.params.userId;

    if (String(targetId) === String(req.user.user_id)) {
        return res.status(400).json({ message: "자기 자신의 권한은 변경할 수 없습니다." });
    }

    db.query("SELECT is_admin FROM users WHERE user_id = ?", [targetId], (err, rows) => {
        if (err || rows.length === 0) return res.status(404).json({ message: "유저를 찾을 수 없습니다." });
        const newVal = rows[0].is_admin ? 0 : 1;
        db.query("UPDATE users SET is_admin = ? WHERE user_id = ?", [newVal, targetId], (err2) => {
            if (err2) return res.status(500).json({ message: "권한 변경 실패" });
            return res.status(200).json({ message: `관리자 권한 ${newVal ? "부여" : "해제"} 완료`, is_admin: newVal });
        });
    });
});

// ─── 전체 강의 목록 조회 ────────────────────────────────────────────
app.get("/api/admin/lectures", requireAdmin, (req, res) => {
    db.query(
        `SELECT l.id, l.title, l.created_at, u.name AS user_name, u.email AS user_email
         FROM lectures l
         JOIN users u ON l.user_id = u.user_id
         ORDER BY l.created_at DESC`,
        (err, results) => {
            if (err) return res.status(500).json({ message: "전체 강의 조회 실패" });
            return res.status(200).json(results);
        }
    );
});

// ─── 강의 삭제 ─────────────────────────────────────────────────────
app.delete("/api/admin/lectures/:lectureId", requireAdmin, (req, res) => {
    const lectureId = req.params.lectureId;

    // 파일 경로 조회 후 → 퀴즈 히스토리 → 강의 순으로 삭제
    db.query("SELECT summary_data FROM lectures WHERE id = ?", [lectureId], (e0, rows) => {
        if (e0) return res.status(500).json({ message: "강의 조회 실패" });
        if (rows.length === 0) return res.status(404).json({ message: "강의를 찾을 수 없습니다." });

        // 실제 파일 삭제 (없는 파일은 조용히 스킵)
        deleteLectureFiles(rows[0].summary_data);

        db.query("DELETE FROM quiz_history WHERE lecture_id = ?", [lectureId], (e1) => {
            if (e1) return res.status(500).json({ message: "퀴즈 히스토리 삭제 실패" });
            db.query("DELETE FROM lectures WHERE id = ?", [lectureId], (e2, result) => {
                if (e2) return res.status(500).json({ message: "강의 삭제 실패" });
                if (result.affectedRows === 0) return res.status(404).json({ message: "강의를 찾을 수 없습니다." });
                return res.status(200).json({ message: "강의가 삭제되었습니다." });
            });
        });
    });
});

// ─── 전체 퀴즈 히스토리 조회 ────────────────────────────────────────
app.get("/api/admin/quiz-history", requireAdmin, (req, res) => {
    db.query(
        `SELECT qh.id, qh.lecture_title, qh.score, qh.correct, qh.total, qh.created_at,
                u.name AS user_name, u.email AS user_email
         FROM quiz_history qh
         JOIN users u ON qh.user_id = u.user_id
         ORDER BY qh.created_at DESC
         LIMIT 200`,
        (err, results) => {
            if (err) return res.status(500).json({ message: "퀴즈 히스토리 조회 실패" });
            return res.status(200).json(results);
        }
    );
});

// ─── 관리자 대시보드 통계 ────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, (req, res) => {
    const run = (sql, params = []) =>
        new Promise((resolve, reject) =>
            db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)))
        );

    (async () => {
        const [
            userCount,
            verifiedCount,
            lectureCount,
            quizCount,
            avgScore,
            newUsersWeek,
            newLecturesWeek,
            dailyUsers,
            dailyLectures,
            topQuizzers,
        ] = await Promise.all([
            run("SELECT COUNT(*) AS cnt FROM users"),
            run("SELECT COUNT(*) AS cnt FROM users WHERE is_verified = 1"),
            run("SELECT COUNT(*) AS cnt FROM lectures"),
            run("SELECT COUNT(*) AS cnt FROM quiz_history"),
            run("SELECT ROUND(AVG(score), 1) AS avg FROM quiz_history"),
            run("SELECT COUNT(*) AS cnt FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"),
            run("SELECT COUNT(*) AS cnt FROM lectures WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"),
            run(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt
                 FROM users
                 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
                 GROUP BY day ORDER BY day ASC`),
            run(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt
                 FROM lectures
                 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
                 GROUP BY day ORDER BY day ASC`),
            run(`SELECT u.name, u.email, COUNT(*) AS quiz_cnt, ROUND(AVG(qh.score),1) AS avg_score, SUM(qh.total) AS total_questions
                 FROM quiz_history qh
                 JOIN users u ON qh.user_id = u.user_id
                 GROUP BY qh.user_id, u.name, u.email
                 ORDER BY (COUNT(*) * SUM(qh.total)) DESC LIMIT 5`),
        ]);

        return res.status(200).json({
            userCount: userCount[0].cnt,
            verifiedCount: verifiedCount[0].cnt,
            lectureCount: lectureCount[0].cnt,
            quizCount: quizCount[0].cnt,
            avgScore: avgScore[0].avg ?? 0,
            newUsersWeek: newUsersWeek[0].cnt,
            newLecturesWeek: newLecturesWeek[0].cnt,
            dailyUsers,
            dailyLectures,
            topQuizzers,
        });
    })().catch((err) => {
        console.error("통계 조회 오류:", err);
        return res.status(500).json({ message: "통계 조회 실패" });
    });
});

// ─── 유저 상세 조회 (강의 목록 + 퀴즈 히스토리) ──────────────────────
app.get("/api/admin/users/:userId/detail", requireAdmin, (req, res) => {
    const { userId } = req.params;
    const run = (sql, params = []) =>
        new Promise((resolve, reject) =>
            db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)))
        );

    (async () => {
        const [userRows, lectures, quizHistory] = await Promise.all([
            run(
                "SELECT user_id, name, email, is_verified, is_admin, created_at FROM users WHERE user_id = ?",
                [userId]
            ),
            run(
                "SELECT id, title, created_at FROM lectures WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
                [userId]
            ),
            run(
                `SELECT id, lecture_title, score, correct, total, created_at
                 FROM quiz_history WHERE user_id = ?
                 ORDER BY created_at DESC LIMIT 20`,
                [userId]
            ),
        ]);

        if (userRows.length === 0) return res.status(404).json({ message: "유저를 찾을 수 없습니다." });

        return res.status(200).json({
            user: userRows[0],
            lectures,
            quizHistory,
        });
    })().catch((err) => {
        console.error("유저 상세 조회 오류:", err);
        return res.status(500).json({ message: "유저 상세 조회 실패" });
    });
});

server.listen(PORT, () => {
    console.log(`✅ 서버 실행 중: ${PORT}`);
});