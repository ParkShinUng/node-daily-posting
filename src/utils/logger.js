import winston from 'winston';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import config from '../config.js';

// 로그 디렉토리 생성
if (!existsSync(config.paths.logs)) {
  mkdirSync(config.paths.logs, { recursive: true });
}

// 타임스탬프 포맷
const timestamp = winston.format.timestamp({
  format: 'YYYY-MM-DD HH:mm:ss',
});

// 로그 포맷
const logFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`;
});

// 로거 생성
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(timestamp, logFormat),
  transports: [
    // 콘솔 출력
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        timestamp,
        logFormat
      ),
    }),
    // 전체 로그 파일
    new winston.transports.File({
      filename: join(config.paths.logs, 'app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // 에러 로그 파일
    new winston.transports.File({
      filename: join(config.paths.logs, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

export default logger;
