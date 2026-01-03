import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from './logger.js';

// 인증 데이터 저장 디렉토리
const AUTH_DIR = config.paths.auth;

if (!existsSync(AUTH_DIR)) {
  mkdirSync(AUTH_DIR, { recursive: true });
}

class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
  }

  /**
   * 브라우저 및 컨텍스트 생성
   * @param {string} sessionName - 세션 이름 (chatgpt, tistory 등)
   * @param {object} options - 추가 옵션
   */
  async launch(sessionName = 'default', options = {}) {
    const storagePath = join(AUTH_DIR, `${sessionName}-state.json`);
    const hasStorageState = existsSync(storagePath);

    logger.info(`브라우저 시작`, { sessionName, headless: config.browser.headless });

    this.browser = await chromium.launch({
      headless: config.browser.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
      ],
    });

    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...options,
    };

    // 저장된 세션이 있으면 로드
    if (hasStorageState) {
      logger.info(`저장된 세션 로드`, { sessionName });
      contextOptions.storageState = storagePath;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.storagePath = storagePath;

    return { browser: this.browser, context: this.context };
  }

  /**
   * 새 페이지 생성
   */
  async newPage() {
    if (!this.context) {
      throw new Error('브라우저 컨텍스트가 초기화되지 않았습니다.');
    }
    return await this.context.newPage();
  }

  /**
   * 세션 상태 저장
   */
  async saveSession() {
    if (!this.context || !this.storagePath) {
      throw new Error('저장할 세션이 없습니다.');
    }
    await this.context.storageState({ path: this.storagePath });
    logger.info(`세션 저장 완료`, { path: this.storagePath });
  }

  /**
   * 브라우저 종료
   * @param {boolean} saveState - 세션 저장 여부
   */
  async close(saveState = true) {
    if (saveState && this.context) {
      await this.saveSession();
    }
    if (this.browser) {
      await this.browser.close();
      logger.info('브라우저 종료');
    }
    this.browser = null;
    this.context = null;
  }

  /**
   * API 요청용 컨텍스트 반환
   */
  getRequestContext() {
    if (!this.context) {
      throw new Error('브라우저 컨텍스트가 초기화되지 않았습니다.');
    }
    return this.context.request;
  }
}

export default BrowserManager;
