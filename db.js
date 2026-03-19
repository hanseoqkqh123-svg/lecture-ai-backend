const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) {
    console.error("❌ DB 연결 실패! 비밀번호나 설정을 확인해주세요:", err.message);
    return;
  }

  console.log("✅ MySQL 데이터베이스 연결 성공!");
});

module.exports = db;