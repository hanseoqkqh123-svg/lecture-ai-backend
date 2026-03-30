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
const ffmpegPath = require("ffmpeg-static");
const { execSync } = require("child_process");
require("dotenv").config();

if (!fs.existsSync("uploads_tmp/")) fs.mkdirSync("uploads_tmp/");
const upload = multer({ dest: "uploads_tmp/" }); 

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
app.delete("/api/lectures/:lectureId", (req, res) => {
  const lectureId = req.params.lectureId;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "user_id가 필요합니다." });
  }

  const deleteQuizHistorySql = `DELETE FROM quiz_history WHERE lecture_id = ? AND user_id = ?`;
  const deleteLectureSql = `DELETE FROM lectures WHERE lecture_id = ? AND user_id = ?`;

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

// STT - Whisper
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "오디오 파일이 없습니다." });
    }

    console.log("📂 mimetype:", req.file.mimetype);
    console.log("📂 size:", req.file.size, "bytes");

    const tmpPath = req.file.path;
    const convertedPath = tmpPath + ".mp3";

    try {
        execSync(`"${ffmpegPath}" -y -i "${tmpPath}" -ar 16000 -ac 1 -b:a 64k "${convertedPath}"`);

        const formData = new FormData();
        formData.append("file", fs.createReadStream(convertedPath), {
            filename: "audio.mp3",
            contentType: "audio/mpeg",
        });
        formData.append("model", "whisper-1");
        formData.append("language", "ko");

        const whisperRes = await fetch(
            "https://api.openai.com/v1/audio/transcriptions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    ...formData.getHeaders(),
                },
                body: formData,
            }
        );

        const whisperData = await whisperRes.json();

        if (!whisperRes.ok) {
            throw new Error(whisperData.error?.message || "Whisper 변환 실패");
        }

        return res.status(200).json({ text: whisperData.text });
    } catch (error) {
        console.error("Whisper 오류:", error);
        return res.status(500).json({ message: error.message || "STT 오류" });
    } finally {
        fs.unlink(tmpPath, () => { });
        fs.unlink(convertedPath, () => { });
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
                        content: `다음 강의 내용을 분석해서 반드시 아래 JSON 형식으로만 응답해. 다른 텍스트는 절대 포함하지 마.

강의 내용:
"""
${text.slice(0, 8000)}
"""

응답 형식:
{
  "summary": "3~5문장으로 핵심 내용 요약",
  "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"],
  "quiz": [
    { "question": "질문1", "answer": "정답1" },
    { "question": "질문2", "answer": "정답2" },
    { "question": "질문3", "answer": "정답3" }
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

