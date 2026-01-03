import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// .env 파일 로드
const envPath = join(rootDir, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn('⚠️  .env 파일이 없습니다. .env.example을 참고하여 생성해주세요.');
}

// 환경변수 검증
function getEnvVar(name, required = true) {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`환경변수 ${name}이(가) 설정되지 않았습니다.`);
  }
  return value || '';
}

export const config = {
  // ChatGPT
  chatgpt: {
    email: getEnvVar('CHATGPT_EMAIL', false),
    password: getEnvVar('CHATGPT_PASSWORD', false),
  },

  // Tistory (웹 로그인 방식)
  tistory: {
    email: getEnvVar('TISTORY_ID', false),
    password: getEnvVar('TISTORY_PASSWORD', false),
    blogName: getEnvVar('TISTORY_BLOG_NAME', false),
  },

  // 브라우저
  browser: {
    headless: process.env.HEADLESS === 'true',
  },

  // 경로
  paths: {
    root: rootDir,
    auth: join(rootDir, '.auth'),
    logs: join(rootDir, 'logs'),
    config: join(rootDir, 'config'),
  },
};

// 설정 검증 함수
export function validateConfig(service) {
  if (service === 'chatgpt') {
    if (!config.chatgpt.email || !config.chatgpt.password) {
      throw new Error('ChatGPT 로그인 정보가 설정되지 않았습니다.');
    }
  }

  if (service === 'tistory') {
    if (!config.tistory.email || !config.tistory.password) {
      throw new Error('Tistory 로그인 정보가 설정되지 않았습니다.');
    }
  }
}

export default config;
