import BrowserManager from '../utils/browser.js';
import config, { validateConfig } from '../config.js';
import logger from '../utils/logger.js';
import { delay, retryWithBackoff } from '../utils/helpers.js';

const CHATGPT_URL = 'https://chatgpt.com';
const SESSION_NAME = 'chatgpt';

// 설정 상수
const RESPONSE_CHECK_INTERVAL = 2000; // 응답 체크 간격 (ms)
const STABLE_THRESHOLD = 3; // 응답 완료 판정 횟수
const DEFAULT_MAX_WAIT = 600000; // 기본 최대 대기 시간 (10분)
const PAGE_LOAD_TIMEOUT = 30000; // 페이지 로드 타임아웃 (30초)
const ELEMENT_TIMEOUT = 10000; // 요소 대기 타임아웃 (10초)

class ChatGPTService {
  constructor() {
    this.browserManager = new BrowserManager();
    this.page = null;
    this.isInitialized = false;
  }

  /**
   * ChatGPT 초기화 및 로그인
   */
  async initialize() {
    logger.info('ChatGPT 서비스 초기화 시작');

    try {
      // 브라우저 시작
      await this.browserManager.launch(SESSION_NAME);
      this.page = await this.browserManager.newPage();

      if (!this.page) {
        throw new Error('페이지 생성 실패');
      }

      // ChatGPT 접속
      await this.navigateToChat();

      // 로그인 상태 확인
      const isLoggedIn = await this.checkLoginStatus();

      if (!isLoggedIn) {
        logger.info('로그인 필요 - 로그인 프로세스 시작');
        await this.login();
      } else {
        logger.info('기존 세션으로 로그인 상태 유지');
      }

      this.isInitialized = true;
      return this;
    } catch (error) {
      logger.error('ChatGPT 초기화 실패', { error: error.message });
      await this.close();
      throw new Error(`ChatGPT 초기화 실패: ${error.message}`);
    }
  }

  /**
   * ChatGPT 페이지로 이동
   */
  async navigateToChat() {
    try {
      await this.page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT
      });
      await delay(2000);
    } catch (error) {
      logger.warn('페이지 이동 실패, 재시도', { error: error.message });
      // 재시도
      await delay(3000);
      await this.page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT
      });
      await delay(2000);
    }
  }

  /**
   * 로그인 상태 확인
   */
  async checkLoginStatus() {
    try {
      // 로그인 버튼이 있으면 미로그인 상태
      const loginButton = await this.page.$('button[data-testid="login-button"]');
      if (loginButton) {
        return false;
      }

      // 입력창이 있으면 로그인 상태
      const inputField = await this.page.$('div[id="prompt-textarea"]');
      return inputField !== null;
    } catch (error) {
      logger.warn('로그인 상태 확인 실패', { error: error.message });
      return false;
    }
  }

  /**
   * ChatGPT 로그인
   */
  async login() {
    validateConfig('chatgpt');

    try {
      const loginButton = await this.page.waitForSelector('button[data-testid="login-button"]', {
        timeout: ELEMENT_TIMEOUT,
      });
      await loginButton.click();
      await delay(2000);

      const googleLoginButton = await this.page.waitForSelector(
        'button:has-text("Google로 계속하기"), button:has-text("Continue with Google")',
        { timeout: ELEMENT_TIMEOUT }
      );
      await googleLoginButton.click();

      // Google 로그인 페이지 대기
      const googleTimeout = 300000;
      const googleStartTime = Date.now();
      while (!this.page.url().includes('accounts.google.com')) {
        if (Date.now() - googleStartTime > googleTimeout) {
          throw new Error('Google 로그인 페이지 로딩 시간 초과');
        }
        await delay(100);
      }

      // 이메일 입력
      const emailInput = await this.page.waitForSelector('input[name="identifier"], input[type="email"]', {
        timeout: 15000,
      });
      await emailInput.fill(config.chatgpt.email);

      // 로그인 완료 대기
      const loginTimeout = 300000;
      const loginStartTime = Date.now();
      while (!this.page.url().includes('https://chatgpt.com/')) {
        if (Date.now() - loginStartTime > loginTimeout) {
          throw new Error('ChatGPT 로그인 완료 대기 시간 초과');
        }
        await delay(100);
      }

      await this.browserManager.saveSession();
      logger.info('로그인 성공');
    } catch (error) {
      logger.error('로그인 실패', { error: error.message });
      throw new Error(`ChatGPT 로그인 실패: ${error.message}`);
    }
  }

  /**
   * 새 대화 시작
   */
  async startNewChat() {
    logger.info('새 대화 시작');

    const methods = [
      // 방법 1: 새 대화 버튼 클릭
      async () => {
        const newChatButton = await this.page.$('a[href="/"]');
        if (newChatButton) {
          await newChatButton.click({ timeout: 5000 });
          await delay(1500);
          return true;
        }
        return false;
      },
      // 방법 2: 사이드바 새 대화 버튼
      async () => {
        const sidebarButton = await this.page.$('nav a[href="/"]');
        if (sidebarButton) {
          await sidebarButton.click({ timeout: 5000 });
          await delay(1500);
          return true;
        }
        return false;
      },
      // 방법 3: 직접 네비게이션
      async () => {
        await this.page.goto(CHATGPT_URL, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_LOAD_TIMEOUT
        });
        await delay(2000);
        return true;
      }
    ];

    for (let i = 0; i < methods.length; i++) {
      try {
        const success = await methods[i]();
        if (success) {
          // 입력창이 준비되었는지 확인
          const inputReady = await this.waitForInputReady(5000);
          if (inputReady) {
            logger.info('새 대화 준비 완료');
            return;
          }
        }
      } catch (error) {
        logger.warn(`새 대화 시작 방법 ${i + 1} 실패`, { error: error.message });
      }
    }

    // 모든 방법 실패 시 페이지 새로고침
    logger.warn('모든 방법 실패, 페이지 새로고침');
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    await delay(3000);
  }

  /**
   * 입력창 준비 대기
   */
  async waitForInputReady(timeout = ELEMENT_TIMEOUT) {
    try {
      await this.page.waitForSelector('div[id="prompt-textarea"]', { timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 프롬프트 전송 및 응답 받기 (재시도 포함)
   */
  async sendPrompt(prompt, maxWaitTime = DEFAULT_MAX_WAIT) {
    if (!this.isInitialized) {
      throw new Error('ChatGPT 서비스가 초기화되지 않았습니다');
    }

    return retryWithBackoff(
      () => this._sendAndReceive(prompt, maxWaitTime),
      {
        maxRetries: 2,
        initialDelay: 5000,
        taskName: 'ChatGPT 응답'
      }
    );
  }

  /**
   * 실제 프롬프트 전송 및 응답 수신
   */
  async _sendAndReceive(prompt, maxWaitTime) {
    logger.info('프롬프트 전송 시작', { promptLength: prompt.length });

    try {
      // 입력창 대기 및 확인
      const inputField = await this.getInputField();
      if (!inputField) {
        throw new Error('입력창을 찾을 수 없습니다');
      }

      // 기존 내용 클리어 및 새 프롬프트 입력
      await this.fillPrompt(inputField, prompt);

      // 전송 버튼 클릭
      await this.clickSendButton();

      logger.info('프롬프트 전송 완료, 응답 대기 중...');

      // 응답 완료 대기
      const response = await this.waitForResponse(maxWaitTime);

      if (!response || response.trim().length === 0) {
        throw new Error('빈 응답을 받았습니다');
      }

      logger.info('응답 수신 완료', { responseLength: response.length });

      return response;
    } catch (error) {
      logger.error('프롬프트 전송/응답 실패', { error: error.message });

      // 오류 복구 시도
      await this.tryRecoverFromError();

      throw error;
    }
  }

  /**
   * 입력창 요소 가져오기
   */
  async getInputField() {
    const selectors = [
      'div[id="prompt-textarea"]',
      'textarea[id="prompt-textarea"]',
      '#prompt-textarea'
    ];

    for (const selector of selectors) {
      try {
        const field = await this.page.waitForSelector(selector, { timeout: ELEMENT_TIMEOUT });
        if (field) return field;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 프롬프트 입력
   */
  async fillPrompt(inputField, prompt) {
    const methods = [
      // 방법 1: Playwright fill (contenteditable div 지원)
      async () => {
        await inputField.click();
        await delay(200);
        await inputField.fill(prompt);
        await delay(500);
        return await this.verifyInputContent(prompt);
      },
      // 방법 2: 직접 텍스트 설정 + input 이벤트
      async () => {
        await this.page.evaluate((text) => {
          const el = document.querySelector('#prompt-textarea');
          if (el) {
            el.focus();
            el.textContent = '';
            el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, prompt);
        await delay(500);
        return await this.verifyInputContent(prompt);
      },
      // 방법 3: 키보드로 직접 입력 (느리지만 확실)
      async () => {
        await inputField.click();
        await delay(200);
        // 기존 내용 선택 후 삭제
        await this.page.keyboard.press('Control+a');
        await this.page.keyboard.press('Backspace');
        await delay(200);
        // 짧은 프롬프트면 직접 타이핑
        if (prompt.length < 500) {
          await this.page.keyboard.type(prompt, { delay: 5 });
        } else {
          // 긴 프롬프트는 클립보드 사용
          await this.page.evaluate((text) => navigator.clipboard.writeText(text), prompt);
          await this.page.keyboard.press('Control+v');
        }
        await delay(500);
        return await this.verifyInputContent(prompt);
      }
    ];

    for (let i = 0; i < methods.length; i++) {
      try {
        const success = await methods[i]();
        if (success) {
          logger.info(`프롬프트 입력 성공 (방법 ${i + 1})`);
          return;
        }
        logger.warn(`프롬프트 입력 방법 ${i + 1} 실패, 다음 방법 시도`);
      } catch (error) {
        logger.warn(`프롬프트 입력 방법 ${i + 1} 오류`, { error: error.message });
      }
    }

    throw new Error('모든 프롬프트 입력 방법 실패');
  }

  /**
   * 입력 내용 확인
   */
  async verifyInputContent(expectedText) {
    try {
      const actualText = await this.page.evaluate(() => {
        const el = document.querySelector('#prompt-textarea');
        return el ? el.textContent || el.innerText || '' : '';
      });
      // 최소 50% 이상 일치하면 성공으로 간주
      const minLength = Math.min(expectedText.length * 0.5, 100);
      return actualText.length >= minLength;
    } catch {
      return false;
    }
  }

  /**
   * 전송 버튼 클릭
   */
  async clickSendButton() {
    const buttonSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="프롬프트 보내기"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="메시지 보내기"]'
    ];

    // 전송 버튼이 나타날 때까지 최대 10초 대기
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const selector of buttonSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button) {
            const isDisabled = await button.isDisabled().catch(() => false);
            if (!isDisabled) {
              await delay(200);
              await button.click();
              logger.info('전송 버튼 클릭 성공', { selector });
              return;
            }
          }
        } catch {
          continue;
        }
      }
      await delay(1000);
    }

    // 버튼을 찾지 못하면 Enter 키 시도
    logger.warn('전송 버튼을 찾지 못함, Enter 키 사용');
    await this.page.keyboard.press('Enter');
  }

  /**
   * 응답 완료 대기 및 텍스트 추출
   */
  async waitForResponse(maxWaitTime) {
    const startTime = Date.now();
    let lastResponseLength = 0;
    let stableCount = 0;
    let noResponseCount = 0;
    const MAX_NO_RESPONSE = 30; // 60초 동안 응답 없으면 에러

    while (Date.now() - startTime < maxWaitTime) {
      await delay(RESPONSE_CHECK_INTERVAL);

      try {
        // 에러 메시지 확인
        const errorMessage = await this.checkForErrors();
        if (errorMessage) {
          throw new Error(`ChatGPT 오류: ${errorMessage}`);
        }

        // 응답 메시지 요소 찾기
        const responseElements = await this.page.$$('div[data-message-author-role="assistant"]');

        if (responseElements.length === 0) {
          noResponseCount++;
          if (noResponseCount >= MAX_NO_RESPONSE) {
            throw new Error('응답 요소를 찾을 수 없습니다');
          }
          continue;
        }

        noResponseCount = 0; // 리셋

        // 마지막 응답 추출
        const lastResponse = responseElements[responseElements.length - 1];
        const responseText = await this.safeGetText(lastResponse);

        // 스트리밍 중인지 확인
        const isStreaming = await this.isResponseStreaming();

        if (!isStreaming && responseText.length > 0) {
          if (responseText.length === lastResponseLength) {
            stableCount++;
            if (stableCount >= STABLE_THRESHOLD) {
              return this.cleanResponse(responseText);
            }
          } else {
            stableCount = 0;
            lastResponseLength = responseText.length;
          }
        } else {
          stableCount = 0;
        }
      } catch (error) {
        // 페이지 오류 등 예외 처리
        if (error.message.includes('ChatGPT 오류')) {
          throw error;
        }
        logger.warn('응답 대기 중 오류', { error: error.message });
      }
    }

    throw new Error('응답 대기 시간 초과');
  }

  /**
   * 에러 메시지 확인
   */
  async checkForErrors() {
    try {
      // 에러 토스트/모달 확인
      const errorSelectors = [
        'div[role="alert"]',
        '.text-red-500',
        '[data-testid="error-message"]'
      ];

      for (const selector of errorSelectors) {
        const errorEl = await this.page.$(selector);
        if (errorEl) {
          const text = await errorEl.innerText().catch(() => '');
          if (text && (text.includes('error') || text.includes('오류') || text.includes('실패'))) {
            return text;
          }
        }
      }

      // 네트워크 오류 확인
      const networkError = await this.page.$('text="Something went wrong"');
      if (networkError) {
        return 'Something went wrong - 네트워크 오류';
      }

      // 용량 초과 확인
      const limitError = await this.page.$('text="limit"');
      if (limitError) {
        return '사용량 제한 초과';
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 스트리밍 중인지 확인
   */
  async isResponseStreaming() {
    try {
      const stopButton = await this.page.$('button[aria-label="Stop generating"]');
      if (stopButton) return true;

      const stopButton2 = await this.page.$('button[aria-label="응답 중지"]');
      if (stopButton2) return true;

      // 타이핑 인디케이터 확인
      const typingIndicator = await this.page.$('.result-streaming');
      if (typingIndicator) return true;

      return false;
    } catch {
      return false;
    }
  }

  /**
   * 안전하게 텍스트 추출
   */
  async safeGetText(element) {
    try {
      return await element.innerText();
    } catch {
      try {
        return await element.textContent();
      } catch {
        return '';
      }
    }
  }

  /**
   * 오류 복구 시도
   */
  async tryRecoverFromError() {
    try {
      logger.info('오류 복구 시도');

      // 모달/팝업 닫기 시도
      const closeButtons = await this.page.$$('button[aria-label="Close"], button[aria-label="닫기"]');
      for (const btn of closeButtons) {
        try {
          await btn.click();
          await delay(500);
        } catch {
          continue;
        }
      }

      // 페이지 새로고침
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
      await delay(3000);
    } catch (error) {
      logger.warn('오류 복구 실패', { error: error.message });
    }
  }

  /**
   * 응답 텍스트 정리
   */
  cleanResponse(text) {
    if (!text) return '';

    return text
      .replace(/^Copy code\n?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * JSON 문자열 추출
   */
  extractJsonString(response) {
    if (!response) return '';

    // 코드 블록 내 JSON 추출 (```json ... ``` 또는 ``` ... ```)
    const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // JSON 객체 패턴 추출
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return response;
  }

  /**
   * 이스케이프된 문자열을 실제 문자로 변환
   */
  unescapeString(str) {
    if (!str) return str;
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  /**
   * JSON 복구 시도 (흔한 오류 수정)
   */
  tryRepairJson(jsonString) {
    if (!jsonString) return null;

    // 방법 1: content 필드를 별도로 추출하여 재구성
    try {
      const keywordMatch = jsonString.match(/"keyword"\s*:\s*"([^"]*?)"/);
      const titleMatch = jsonString.match(/"title"\s*:\s*"([^"]*?)"/);
      const tagsMatch = jsonString.match(/"tags"\s*:\s*\[([\s\S]*?)\]/);

      // content 필드 추출 (여러 패턴 시도)
      let content = null;

      // 패턴 1: "content": "..." , "tags"
      let contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"/);
      if (contentMatch) {
        content = contentMatch[1];
      }

      // 패턴 2: "content": "..." }
      if (!content) {
        contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
        if (contentMatch) {
          content = contentMatch[1];
        }
      }

      // 패턴 3: "content": "...", 로 끝나는 경우
      if (!content) {
        contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*,/);
        if (contentMatch) {
          content = contentMatch[1];
        }
      }

      if (keywordMatch && titleMatch && content) {
        // tags 파싱
        let tags = [];
        if (tagsMatch) {
          const tagsContent = tagsMatch[1];
          const tagMatches = tagsContent.match(/"([^"]+)"/g);
          if (tagMatches) {
            tags = tagMatches.map(t => t.replace(/"/g, ''));
          }
        }

        // 이스케이프된 문자열 변환
        return {
          keyword: this.unescapeString(keywordMatch[1]),
          title: this.unescapeString(titleMatch[1]),
          content: this.unescapeString(content),
          tags
        };
      }
    } catch (e) {
      // 방법 1 실패
    }

    // 방법 2: 라인별 파싱으로 content 추출
    try {
      const lines = jsonString.split('\n');
      let keyword = '';
      let title = '';
      let tags = [];
      let inContent = false;
      let contentLines = [];

      for (const line of lines) {
        if (line.includes('"keyword"') && !keyword) {
          const match = line.match(/"keyword"\s*:\s*"([^"]*)"/);
          if (match) keyword = match[1];
        } else if (line.includes('"title"') && !title) {
          const match = line.match(/"title"\s*:\s*"([^"]*)"/);
          if (match) title = match[1];
        } else if (line.includes('"content"') && !inContent) {
          inContent = true;
          const match = line.match(/"content"\s*:\s*"(.*)$/);
          if (match) contentLines.push(match[1]);
        } else if (inContent && line.includes('"tags"')) {
          inContent = false;
          if (contentLines.length > 0) {
            let lastLine = contentLines[contentLines.length - 1];
            lastLine = lastLine.replace(/"\s*,\s*$/, '');
            contentLines[contentLines.length - 1] = lastLine;
          }
          // tags 추출
          const tagsMatch = line.match(/\[([\s\S]*?)\]/);
          if (tagsMatch) {
            const tagMatches = tagsMatch[1].match(/"([^"]+)"/g);
            if (tagMatches) {
              tags = tagMatches.map(t => t.replace(/"/g, ''));
            }
          }
        } else if (inContent) {
          contentLines.push(line);
        } else if (line.includes('"tags"') && tags.length === 0) {
          const tagsMatch = line.match(/\[([\s\S]*?)\]/);
          if (tagsMatch) {
            const tagMatches = tagsMatch[1].match(/"([^"]+)"/g);
            if (tagMatches) {
              tags = tagMatches.map(t => t.replace(/"/g, ''));
            }
          }
        }
      }

      let content = contentLines.join('\n');
      content = content.replace(/"\s*,?\s*$/, '');

      if (keyword && title && content) {
        // 이스케이프된 문자열 변환
        return {
          keyword: this.unescapeString(keyword),
          title: this.unescapeString(title),
          content: this.unescapeString(content),
          tags
        };
      }
    } catch (e) {
      // 방법 2 실패
    }

    // 방법 3: 컨트롤 문자 제거 후 재파싱
    try {
      // 컨트롤 문자 제거 (탭, 줄바꿈 제외)
      const cleaned = jsonString.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      const parsed = JSON.parse(cleaned);
      if (parsed.keyword && parsed.title && parsed.content) {
        return parsed;
      }
    } catch (e) {
      // 방법 3 실패
    }

    return null;
  }

  /**
   * 응답에서 블로그 포스트 파싱
   */
  parseResponse(response) {
    if (!response) {
      throw new Error('응답이 비어있습니다');
    }

    const result = {
      keyword: '',
      title: '',
      content: '',
      tags: [],
    };

    const jsonString = this.extractJsonString(response);

    if (!jsonString) {
      throw new Error('JSON 문자열을 찾을 수 없습니다');
    }

    // 1차 시도: 직접 파싱
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.keyword && parsed.title && parsed.content) {
        result.keyword = parsed.keyword;
        result.title = parsed.title;
        result.content = parsed.content;
        result.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
        logger.info('JSON 파싱 성공', { keyword: result.keyword, title: result.title });
        return result;
      }
    } catch (firstError) {
      logger.warn('JSON 직접 파싱 실패, 복구 시도', { error: firstError.message });
    }

    // 2차 시도: JSON 복구
    try {
      const repaired = this.tryRepairJson(jsonString);
      if (repaired && repaired.keyword && repaired.title && repaired.content) {
        result.keyword = repaired.keyword;
        result.title = repaired.title;
        result.content = repaired.content;
        result.tags = Array.isArray(repaired.tags) ? repaired.tags : [];
        logger.info('JSON 복구 파싱 성공', { keyword: result.keyword, title: result.title });
        return result;
      }
    } catch (repairError) {
      logger.warn('JSON 복구 실패', { error: repairError.message });
    }

    // 3차 시도: 원본 응답에서 직접 복구
    try {
      const repaired = this.tryRepairJson(response);
      if (repaired && repaired.keyword && repaired.title && repaired.content) {
        result.keyword = repaired.keyword;
        result.title = repaired.title;
        result.content = repaired.content;
        result.tags = Array.isArray(repaired.tags) ? repaired.tags : [];
        logger.info('원본 응답 복구 파싱 성공', { keyword: result.keyword, title: result.title });
        return result;
      }
    } catch (rawRepairError) {
      logger.warn('원본 응답 복구 실패', { error: rawRepairError.message });
    }

    // 모든 시도 실패
    logger.error('JSON 파싱 최종 실패', {
      responseLength: response.length,
      jsonStringLength: jsonString.length
    });
    throw new Error('응답 JSON 파싱 실패: 유효한 JSON 형식을 찾을 수 없습니다');
  }

  /**
   * 서비스 종료
   */
  async close() {
    try {
      if (this.browserManager) {
        await this.browserManager.close(true);
      }
      this.isInitialized = false;
      logger.info('ChatGPT 서비스 종료');
    } catch (error) {
      logger.error('ChatGPT 서비스 종료 중 오류', { error: error.message });
    }
  }
}

export default ChatGPTService;
