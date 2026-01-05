import BrowserManager from '../utils/browser.js';
import config, { validateConfig } from '../config.js';
import logger from '../utils/logger.js';

const CHATGPT_URL = 'https://chatgpt.com';
const SESSION_NAME = 'chatgpt';

class ChatGPTService {
  constructor() {
    this.browserManager = new BrowserManager();
    this.page = null;
  }

  /**
   * ChatGPT 초기화 및 로그인
   */
  async initialize() {
    logger.info('ChatGPT 서비스 초기화 시작');

    await this.browserManager.launch(SESSION_NAME);
    this.page = await this.browserManager.newPage();

    // ChatGPT 페이지 접속
    await this.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2000);

    // 로그인 상태 확인
    const isLoggedIn = await this.checkLoginStatus();

    if (!isLoggedIn) {
      logger.info('로그인 필요 - 로그인 프로세스 시작');
      await this.login();
    } else {
      logger.info('기존 세션으로 로그인 상태 유지');
    }

    return this;
  }

  /**
   * 로그인 상태 확인
   */
  async checkLoginStatus() {
    try {
      // 로그인 버튼이 있으면
      const loginButton = await this.page.$('button[data-testid="login-button"]');
      return loginButton === null;
    } catch {
      return false;
    }
  }

  /**
   * ChatGPT 로그인
   */
  async login() {
    validateConfig('chatgpt');

    try {
      // 로그인 버튼 클릭
      const loginButton = await this.page.waitForSelector('button[data-testid="login-button"]', {
        timeout: 10000,
      });
      await loginButton.click();

      await this.page.waitForTimeout(2000);

      const googleLoginButton = await this.page.waitForSelector('button:has-text("Google로 계속하기"), button:has-text("Continue with Google")', {
        timeout: 10000,
      });
      await googleLoginButton.click();
      
      // URL 변경 대기 (타임아웃 5분)
      const googleTimeout = 300000;
      const googleStartTime = Date.now();
      while (!this.page.url().includes('accounts.google.com')) {
        if (Date.now() - googleStartTime > googleTimeout) {
          throw new Error('Google 로그인 페이지 로딩 시간 초과');
        }
        await this.page.waitForTimeout(100);
      }

      // 이메일 입력
      const emailInput = await this.page.waitForSelector('input[name="identifier"], input[type="email"]', {
        timeout: 15000,
      });
      await emailInput.fill(config.chatgpt.email);

      // 로그인 완료 대기 (타임아웃 5분)
      const loginTimeout = 300000;
      const loginStartTime = Date.now();
      while (!this.page.url().includes('https://chatgpt.com/')) {
        if (Date.now() - loginStartTime > loginTimeout) {
          throw new Error('ChatGPT 로그인 완료 대기 시간 초과');
        }
        await this.page.waitForTimeout(100);
      }

      // 세션 저장
      await this.browserManager.saveSession();

      logger.info('로그인 성공');
    } catch (error) {
      logger.error('로그인 실패', { error: error.message });
      throw new Error(`ChatGPT 로그인 실패: ${error.message}`);
    }
  }

  /**
   * 프롬프트 전송 및 응답 받기
   * @param {string} prompt - 전송할 프롬프트
   * @param {number} maxWaitTime - 최대 대기 시간 (ms)
   */
  async sendPrompt(prompt, maxWaitTime = 600000) {
    logger.info('프롬프트 전송 시작', { promptLength: prompt.length });

    try {
      // 입력창 찾기
      const inputSelector = 'div[id="prompt-textarea"]';
      const inputField = await this.page.waitForSelector(inputSelector, { timeout: 10000 });
      
      // 프롬프트 입력
      await inputField.fill(prompt);
      await this.page.waitForTimeout(500);

      // 전송 버튼 클릭
      const sendButton = await this.page.waitForSelector('button[id="composer-submit-button"]');
      await sendButton.click();

      logger.info('프롬프트 전송 완료, 응답 대기 중...');

      // 응답 완료 대기
      const response = await this.waitForResponse(maxWaitTime);

      logger.info('응답 수신 완료', { responseLength: response.length });

      return response;
    } catch (error) {
      logger.error('프롬프트 전송 실패', { error: error.message });
      throw error;
    }
  }

  /**
   * 응답 완료 대기 및 텍스트 추출
   */
  async waitForResponse(maxWaitTime) {
    const startTime = Date.now();
    let lastResponseLength = 0;
    let stableCount = 0;
    const stableThreshold = 3; // 응답이 3번 연속 동일하면 완료로 간주

    while (Date.now() - startTime < maxWaitTime) {
      await this.page.waitForTimeout(1000);

      // 응답 메시지 요소 찾기
      const responseElements = await this.page.$$('div[data-message-author-role="assistant"]');

      if (responseElements.length === 0) {
        continue;
      }

      // 마지막 응답 추출
      const lastResponse = responseElements[responseElements.length - 1];
      const responseText = await lastResponse.innerText();

      // 스트리밍 중인지 확인 (Stop 버튼 존재 여부)
      const isStreaming = await this.page.$('button[aria-label="Stop generating"]');

      if (!isStreaming) {
        // 응답 길이가 변하지 않으면 카운트 증가
        if (responseText.length === lastResponseLength && responseText.length > 0) {
          stableCount++;
          if (stableCount >= stableThreshold) {
            return this.cleanResponse(responseText);
          }
        } else {
          stableCount = 0;
          lastResponseLength = responseText.length;
        }
      }
    }

    throw new Error('응답 대기 시간 초과');
  }

  /**
   * 응답 텍스트 정리
   */
  cleanResponse(text) {
    return text
      .replace(/^Copy code\n?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 응답에서 블로그 포스트 파싱
   * JSON 형식의 응답에서 keyword, title, body_html, tags 추출
   */
  parseResponse(response) {
    const result = {
      keyword: '',
      title: '',
      content: '',
      tags: [],
    };

    try {
      let jsonString = response;

      const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonBlockMatch) {
        jsonString = jsonBlockMatch[1].trim();
      } else {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonString = jsonMatch[0];
        }
      }

      const parsed = JSON.parse(jsonString);

      result.keyword = parsed.keyword || '';
      result.title = parsed.title || '';
      result.content = parsed.content || '';
      result.tags = Array.isArray(parsed.tags) ? parsed.tags : [];

      logger.info('JSON 파싱 성공', { keyword: result.keyword, title: result.title });
    } catch (error) {
      logger.error('JSON 파싱 실패', { error: error.message });
      throw new Error(`응답 JSON 파싱 실패: ${error.message}`);
    }

    return result;
  }

  /**
   * 서비스 종료
   */
  async close() {
    await this.browserManager.close(true);
    logger.info('ChatGPT 서비스 종료');
  }
}

export default ChatGPTService;
