import BrowserManager from '../utils/browser.js';
import config, { validateConfig } from '../config.js';
import logger from '../utils/logger.js';
import { delay, retryWithBackoff } from '../utils/helpers.js';

const CHATGPT_URL = 'https://chatgpt.com';
const SESSION_NAME = 'chatgpt';

// 설정 상수
const RESPONSE_CHECK_INTERVAL = 2000;
const STABLE_THRESHOLD = 3;
const DEFAULT_MAX_WAIT = 600000;
const PAGE_LOAD_TIMEOUT = 30000;
const ELEMENT_TIMEOUT = 10000;
const IMAGE_WAIT_TIMEOUT = 120000; // 이미지 생성 대기 (2분)

class ChatGPTService {
  constructor() {
    this.browserManager = new BrowserManager();
    this.mainPage = null;
    this.pages = new Map(); // pageId → page
    this.isInitialized = false;
  }

  // ========================================
  // 초기화 및 로그인 (기존 유지)
  // ========================================

  async initialize() {
    logger.info('ChatGPT 서비스 초기화 시작');

    try {
      await this.browserManager.launch(SESSION_NAME);
      this.mainPage = await this.browserManager.newPage();

      if (!this.mainPage) {
        throw new Error('페이지 생성 실패');
      }

      await this.navigateToChat(this.mainPage);

      const isLoggedIn = await this.checkLoginStatus(this.mainPage);

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

  async navigateToChat(page) {
    try {
      await page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT
      });
      await delay(2000);
    } catch (error) {
      logger.warn('페이지 이동 실패, 재시도', { error: error.message });
      await delay(3000);
      await page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT
      });
      await delay(2000);
    }
  }

  async checkLoginStatus(page) {
    try {
      const loginButton = await page.$('button[data-testid="login-button"]');
      if (loginButton) return false;

      const inputField = await page.$('div[id="prompt-textarea"]');
      return inputField !== null;
    } catch (error) {
      logger.warn('로그인 상태 확인 실패', { error: error.message });
      return false;
    }
  }

  async login() {
    validateConfig('chatgpt');

    try {
      const loginButton = await this.mainPage.waitForSelector('button[data-testid="login-button"]', {
        timeout: ELEMENT_TIMEOUT,
      });
      await loginButton.click();
      await delay(2000);

      const googleLoginButton = await this.mainPage.waitForSelector(
        'button:has-text("Google로 계속하기"), button:has-text("Continue with Google")',
        { timeout: ELEMENT_TIMEOUT }
      );
      await googleLoginButton.click();

      const googleTimeout = 300000;
      const googleStartTime = Date.now();
      while (!this.mainPage.url().includes('accounts.google.com')) {
        if (Date.now() - googleStartTime > googleTimeout) {
          throw new Error('Google 로그인 페이지 로딩 시간 초과');
        }
        await delay(100);
      }

      const emailInput = await this.mainPage.waitForSelector('input[name="identifier"], input[type="email"]', {
        timeout: 15000,
      });
      await emailInput.fill(config.chatgpt.email);

      const loginTimeout = 300000;
      const loginStartTime = Date.now();
      while (!this.mainPage.url().includes('https://chatgpt.com/')) {
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

  // ========================================
  // 멀티탭 관리
  // ========================================

  /**
   * 새 ChatGPT 탭 생성 (독립된 대화)
   */
  async createPage(pageId) {
    if (!this.isInitialized) {
      throw new Error('ChatGPT 서비스가 초기화되지 않았습니다');
    }

    logger.info(`[${pageId}] 새 ChatGPT 탭 생성`);
    const page = await this.browserManager.newPage();
    await this.navigateToChat(page);

    // 입력창 준비 대기
    await this.waitForInputReady(page, ELEMENT_TIMEOUT);

    this.pages.set(pageId, page);
    logger.info(`[${pageId}] ChatGPT 탭 준비 완료`);
    return page;
  }

  /**
   * 특정 탭 닫기
   */
  async closePage(pageId) {
    const page = this.pages.get(pageId);
    if (page) {
      try {
        await page.close();
      } catch (e) {
        logger.warn(`[${pageId}] 탭 닫기 실패`, { error: e.message });
      }
      this.pages.delete(pageId);
    }
  }

  // ========================================
  // 프롬프트 전송 (멀티탭 지원)
  // ========================================

  /**
   * 특정 페이지에 프롬프트 전송 (텍스트 응답)
   */
  async sendPromptToPage(page, prompt, maxWaitTime = DEFAULT_MAX_WAIT) {
    return retryWithBackoff(
      () => this._sendAndReceive(page, prompt, maxWaitTime),
      {
        maxRetries: 2,
        initialDelay: 5000,
        taskName: 'ChatGPT 응답'
      }
    );
  }

  /**
   * 하위호환: 기존 sendPrompt (mainPage 사용)
   */
  async sendPrompt(prompt, maxWaitTime = DEFAULT_MAX_WAIT) {
    if (!this.isInitialized) {
      throw new Error('ChatGPT 서비스가 초기화되지 않았습니다');
    }
    return this.sendPromptToPage(this.mainPage, prompt, maxWaitTime);
  }

  async _sendAndReceive(page, prompt, maxWaitTime) {
    logger.info('프롬프트 전송 시작', { promptLength: prompt.length });

    try {
      // 팝업/모달 사전 닫기
      await this.dismissPopups(page);

      const inputField = await this.getInputField(page);
      if (!inputField) {
        throw new Error('입력창을 찾을 수 없습니다');
      }

      await this.fillPrompt(page, inputField, prompt);
      await this.clickSendButton(page);

      logger.info('프롬프트 전송 완료, 응답 대기 중...');

      const response = await this.waitForResponse(page, maxWaitTime);

      if (!response || response.trim().length === 0) {
        throw new Error('빈 응답을 받았습니다');
      }

      logger.info('응답 수신 완료', { responseLength: response.length });
      return response;
    } catch (error) {
      logger.error('프롬프트 전송/응답 실패', { error: error.message });
      await this.tryRecoverFromError(page);
      throw error;
    }
  }

  /**
   * 팝업/모달 자동 닫기
   */
  async dismissPopups(page) {
    try {
      const dismissSelectors = [
        'button[aria-label="Close"]',
        'button[aria-label="닫기"]',
        '[role="dialog"] button:has-text("dismiss")',
        '[role="dialog"] button:has-text("확인")',
        '[role="dialog"] button:has-text("OK")',
      ];

      for (const selector of dismissSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            await btn.click();
            await delay(500);
            logger.info('팝업 닫기 완료', { selector });
          }
        }
      }
    } catch {
      // 무시
    }
  }

  // ========================================
  // 이미지 생성 (NEW)
  // ========================================

  /**
   * DALL-E 이미지 생성 프롬프트 전송 + 이미지 URL 추출
   */
  async generateImage(page, prompt) {
    return retryWithBackoff(
      () => this._generateImage(page, prompt),
      {
        maxRetries: 2,
        initialDelay: 5000,
        taskName: 'DALL-E 이미지 생성'
      }
    );
  }

  async _generateImage(page, prompt) {
    logger.info('이미지 생성 프롬프트 전송 준비', { promptLength: prompt.length });

    // 페이지 준비 상태 재확인
    await delay(2000);

    const inputField = await this.getInputField(page);
    if (!inputField) {
      throw new Error('입력창을 찾을 수 없습니다');
    }

    await this.fillPrompt(page, inputField, prompt);
    await this.clickSendButton(page);

    // 프롬프트가 실제로 전송되었는지 확인
    const promptSent = await this.verifyPromptSent(page);
    if (!promptSent) {
      logger.warn('프롬프트 미전송 감지, Enter 키로 재전송 시도');
      await page.keyboard.press('Enter');
      await delay(3000);
      const retrySent = await this.verifyPromptSent(page, 10000);
      if (!retrySent) {
        throw new Error('이미지 프롬프트 전송 실패: 사용자 메시지가 DOM에 나타나지 않음');
      }
    }

    // DALL-E 이미지 직접 폴링 (assistant div 없이 이미지가 생성될 수 있음)
    logger.info('DALL-E 이미지 생성 대기 시작');
    const imageUrls = await this.waitForImages(page, IMAGE_WAIT_TIMEOUT);

    if (imageUrls.length === 0) {
      // 디버깅: DOM 상태 로깅
      await this.logPageDiagnostics(page);
      throw new Error('생성된 이미지를 찾을 수 없습니다');
    }

    logger.info(`이미지 ${imageUrls.length}장 추출 완료`);
    return imageUrls;
  }

  /**
   * 응답에서 DALL-E 이미지 URL 추출
   */
  async extractImageUrls(page) {
    return await page.evaluate(() => {
      const urls = new Set();

      // 방법 1: "생성된 이미지" alt 태그로 DALL-E 이미지 직접 검색
      const generatedImages = document.querySelectorAll('img[alt="생성된 이미지"], img[alt="Generated image"]');
      for (const img of generatedImages) {
        if (img.src) urls.add(img.src);
      }

      // 방법 2: ChatGPT estuary API 이미지 (DALL-E 결과물)
      const estuaryImages = document.querySelectorAll('img[src*="backend-api/estuary/content"]');
      for (const img of estuaryImages) {
        if (img.src) urls.add(img.src);
      }

      // 방법 3: assistant 응답 내 img 태그
      const responses = document.querySelectorAll('div[data-message-author-role="assistant"]');
      if (responses.length > 0) {
        const lastResponse = responses[responses.length - 1];
        const images = lastResponse.querySelectorAll('img');
        for (const img of images) {
          if (img.src) urls.add(img.src);
        }
      }

      // 방법 4: 전체 대화 영역에서 큰 이미지 (480px 이상) 검색
      const allImages = document.querySelectorAll('main img, article img');
      for (const img of allImages) {
        if (img.src && img.width >= 200) urls.add(img.src);
      }

      // 필터링: 프로필/아이콘 등 제외
      return [...urls].filter(src =>
        src &&
        !src.includes('data:') &&
        !src.includes('.svg') &&
        !src.includes('favicon') &&
        !src.includes('avatar') &&
        !src.includes('icon') &&
        !src.includes('profile_placeholder') &&
        !src.includes('gizmo_id') &&
        (
          src.includes('backend-api/estuary/content') ||
          src.includes('oaidalleapiprodscus') ||
          src.includes('dall-e') ||
          src.includes('blob.core.windows.net') ||
          src.includes('/dalle/')
        )
      );
    });
  }

  /**
   * 프롬프트가 실제로 전송되었는지 확인 (사용자 메시지 DOM 존재 여부)
   */
  async verifyPromptSent(page, timeout = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const userMessages = await page.$$('div[data-message-author-role="user"]');
      if (userMessages.length > 0) {
        logger.info('프롬프트 전송 확인됨 (사용자 메시지 감지)');
        return true;
      }
      await delay(1000);
    }
    logger.warn('프롬프트 전송 확인 실패 - 사용자 메시지 없음');
    return false;
  }

  /**
   * DALL-E 이미지가 DOM에 나타날 때까지 폴링 대기
   *
   * Phase 1: DALL-E 생성 완료 대기 (스트리밍 종료 + 생성 인디케이터 소멸)
   * Phase 2: 이미지 로딩 완료 확인 (img.complete + naturalWidth > 0)
   * Phase 3: 이미지 수 안정화 확인 (3회 연속 동일)
   */
  async waitForImages(page, timeout = 120000) {
    const startTime = Date.now();
    const POLL_INTERVAL = 3000;
    const STABLE_THRESHOLD = 3;
    const STABLE_INTERVAL = 3000;

    logger.info('이미지 로딩 대기 시작');

    // === Phase 1: DALL-E 생성 완료 대기 ===
    let phase1Done = false;
    while (Date.now() - startTime < timeout) {
      const isStreaming = await this.isResponseStreaming(page);
      const isGenerating = await this.isDalleGenerating(page);
      const imageUrls = await this.extractImageUrls(page);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (imageUrls.length > 0 && !isStreaming && !isGenerating) {
        logger.info(`Phase 1 완료: 이미지 ${imageUrls.length}장 감지, 생성 종료 확인 (${elapsed}초)`);
        phase1Done = true;
        break;
      }

      if (elapsed % 10 === 0) {
        logger.info(`이미지 대기 중... (${elapsed}초, 이미지: ${imageUrls.length}장, 스트리밍: ${isStreaming}, 생성중: ${isGenerating})`);
      }

      await delay(POLL_INTERVAL);
    }

    if (!phase1Done) {
      const lastTry = [...new Set(await this.extractImageUrls(page))];
      if (lastTry.length > 0) {
        logger.warn(`Phase 1 타임아웃이지만 이미지 ${lastTry.length}장 발견, 반환`);
        return lastTry;
      }
      logger.warn('이미지 대기 시간 초과');
      return [];
    }

    // === Phase 2: 이미지 로딩 완료 확인 ===
    const loadTimeout = 30000;
    const loadStart = Date.now();
    while (Date.now() - loadStart < loadTimeout) {
      const allLoaded = await this.areImagesLoaded(page);
      if (allLoaded) {
        logger.info('Phase 2 완료: 모든 이미지 로딩 완료');
        break;
      }
      const elapsed = Math.round((Date.now() - loadStart) / 1000);
      if (elapsed % 10 === 0) {
        logger.info(`이미지 로딩 대기 중... (${elapsed}초)`);
      }
      await delay(2000);
    }

    // === Phase 3: 이미지 수 안정화 확인 ===
    let lastCount = 0;
    let stableCount = 0;

    for (let i = 0; i < STABLE_THRESHOLD + 3; i++) {
      await delay(STABLE_INTERVAL);
      const urls = [...new Set(await this.extractImageUrls(page))];

      if (urls.length > 0 && urls.length === lastCount) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD) {
          logger.info(`Phase 3 완료: 이미지 ${urls.length}장 안정화 (${stableCount}회 연속 동일)`);
          return urls;
        }
      } else {
        stableCount = urls.length > 0 ? 1 : 0;
        lastCount = urls.length;
      }
    }

    const finalUrls = [...new Set(await this.extractImageUrls(page))];
    logger.warn(`안정화 미완료, 이미지 ${finalUrls.length}장 반환 (stableCount: ${stableCount}/${STABLE_THRESHOLD})`);
    return finalUrls;
  }

  /**
   * DALL-E 이미지 생성이 진행 중인지 확인
   * (스트리밍과 별개로 DALL-E 고유 로딩 상태 감지)
   */
  async isDalleGenerating(page) {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText || '';

        // DALL-E 생성 진행 텍스트 감지
        const generatingPhrases = [
          'Creating image',
          'Generating image',
          'Generating',
          '이미지 생성 중',
          '이미지를 만들',
          'creating image',
        ];
        for (const phrase of generatingPhrases) {
          if (text.includes(phrase)) return true;
        }

        // DALL-E 로딩 인디케이터 (프로그레스 바, 스피너 등)
        const loadingSelectors = [
          '[data-testid="image-progress"]',
          '[role="progressbar"]',
          '.dalle-progress',
          '.image-gen-loading',
        ];
        for (const sel of loadingSelectors) {
          const el = document.querySelector(sel);
          if (el) return true;
        }

        // 이미지 placeholder/skeleton (src 없이 빈 img 영역)
        const assistantMsgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
        if (assistantMsgs.length > 0) {
          const last = assistantMsgs[assistantMsgs.length - 1];
          const skeletons = last.querySelectorAll('[class*="skeleton"], [class*="shimmer"], [class*="placeholder"]');
          if (skeletons.length > 0) return true;
        }

        return false;
      });
    } catch {
      return false;
    }
  }

  /**
   * 추출된 이미지들이 실제로 로딩 완료되었는지 확인
   * (img.complete === true && naturalWidth > 0)
   */
  async areImagesLoaded(page) {
    try {
      return await page.evaluate(() => {
        const targetImages = [
          ...document.querySelectorAll('img[alt="생성된 이미지"], img[alt="Generated image"]'),
          ...document.querySelectorAll('img[src*="backend-api/estuary/content"]'),
        ];

        if (targetImages.length === 0) return false;

        const unique = [...new Set(targetImages)];
        return unique.every(img => img.complete && img.naturalWidth > 0);
      });
    } catch {
      return false;
    }
  }

  /**
   * 페이지 디버깅 정보 로깅
   */
  async logPageDiagnostics(page) {
    try {
      const diagnostics = await page.evaluate(() => {
        const assistantMsgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
        const userMsgs = document.querySelectorAll('div[data-message-author-role="user"]');
        const allImages = document.querySelectorAll('img');
        const imageInfo = [...allImages].slice(0, 10).map(img => ({
          src: (img.src || '').substring(0, 100),
          alt: img.alt || '',
          width: img.width,
        }));

        return {
          url: window.location.href,
          assistantMsgCount: assistantMsgs.length,
          userMsgCount: userMsgs.length,
          lastAssistantText: assistantMsgs.length > 0
            ? assistantMsgs[assistantMsgs.length - 1].innerText?.substring(0, 300) || ''
            : 'none',
          totalImages: allImages.length,
          imageInfo,
        };
      });

      logger.info('페이지 진단 정보', diagnostics);
    } catch (error) {
      logger.warn('페이지 진단 실패', { error: error.message });
    }
  }

  /**
   * 이미지 URL → Buffer 다운로드
   * ChatGPT estuary URL은 인증이 필요하므로 Playwright 페이지 컨텍스트 사용
   */
  async downloadImage(url, page = null) {
    logger.info('이미지 다운로드 시작', { url: url.substring(0, 100) + '...' });

    try {
      // ChatGPT estuary URL인 경우 Playwright로 다운로드 (쿠키 인증 필요)
      if (url.includes('backend-api/estuary/content') && page) {
        const buffer = await page.evaluate(async (imageUrl) => {
          const response = await fetch(imageUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          return Array.from(new Uint8Array(arrayBuffer));
        }, url);

        const result = Buffer.from(buffer);
        logger.info('이미지 다운로드 완료 (페이지 컨텍스트)', { size: result.length });
        return result;
      }

      // 일반 URL은 Node.js fetch 사용
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`이미지 다운로드 실패: HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      logger.info('이미지 다운로드 완료', { size: buffer.length });
      return buffer;
    } catch (error) {
      logger.error('이미지 다운로드 실패', { error: error.message, url: url.substring(0, 100) });
      throw error;
    }
  }

  // ========================================
  // 입력 및 전송 (page 파라미터 지원)
  // ========================================

  async waitForInputReady(page, timeout = ELEMENT_TIMEOUT) {
    try {
      await page.waitForSelector('div[id="prompt-textarea"]', { timeout });
      return true;
    } catch {
      return false;
    }
  }

  async getInputField(page) {
    const selectors = [
      'div[id="prompt-textarea"]',
      'textarea[id="prompt-textarea"]',
      '#prompt-textarea'
    ];

    for (const selector of selectors) {
      try {
        const field = await page.waitForSelector(selector, { timeout: ELEMENT_TIMEOUT });
        if (field) return field;
      } catch {
        continue;
      }
    }

    return null;
  }

  async fillPrompt(page, inputField, prompt) {
    const methods = [
      // 방법 1: Playwright fill
      async () => {
        await inputField.click();
        await delay(200);
        await inputField.fill(prompt);
        await delay(500);
        return await this.verifyInputContent(page, prompt);
      },
      // 방법 2: 직접 텍스트 설정 + input 이벤트
      async () => {
        await page.evaluate((text) => {
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
        return await this.verifyInputContent(page, prompt);
      },
      // 방법 3: 키보드로 직접 입력
      async () => {
        await inputField.click();
        await delay(200);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await delay(200);
        if (prompt.length < 500) {
          await page.keyboard.type(prompt, { delay: 5 });
        } else {
          await page.evaluate((text) => navigator.clipboard.writeText(text), prompt);
          await page.keyboard.press('Control+v');
        }
        await delay(500);
        return await this.verifyInputContent(page, prompt);
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

  async verifyInputContent(page, expectedText) {
    try {
      const actualText = await page.evaluate(() => {
        const el = document.querySelector('#prompt-textarea');
        return el ? el.textContent || el.innerText || '' : '';
      });
      const minLength = Math.min(expectedText.length * 0.5, 100);
      return actualText.length >= minLength;
    } catch {
      return false;
    }
  }

  async clickSendButton(page) {
    const buttonSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="프롬프트 보내기"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="메시지 보내기"]'
    ];

    for (let attempt = 0; attempt < 10; attempt++) {
      for (const selector of buttonSelectors) {
        try {
          const button = await page.$(selector);
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

    logger.warn('전송 버튼을 찾지 못함, Enter 키 사용');
    await page.keyboard.press('Enter');
  }

  // ========================================
  // 응답 대기 및 파싱 (page 파라미터 지원)
  // ========================================

  async waitForResponse(page, maxWaitTime = DEFAULT_MAX_WAIT, options = {}) {
    const startTime = Date.now();
    let lastResponseLength = 0;
    let stableCount = 0;
    let noResponseCount = 0;
    let checkCount = 0;
    const MAX_NO_RESPONSE = options.maxNoResponse || 30;

    while (Date.now() - startTime < maxWaitTime) {
      await delay(RESPONSE_CHECK_INTERVAL);
      checkCount++;

      try {
        const errorMessage = await this.checkForErrors(page);
        if (errorMessage) {
          throw new Error(`ChatGPT 오류: ${errorMessage}`);
        }

        const responseElements = await page.$$('div[data-message-author-role="assistant"]');

        if (responseElements.length === 0) {
          noResponseCount++;
          // 매 10회(20초)마다 상태 로깅
          if (noResponseCount % 10 === 0) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            logger.info(`응답 대기 중... (${elapsed}초, 미감지 ${noResponseCount}회)`);
          }
          if (noResponseCount >= MAX_NO_RESPONSE) {
            throw new Error('응답 요소를 찾을 수 없습니다');
          }
          continue;
        }

        noResponseCount = 0;

        const lastResponse = responseElements[responseElements.length - 1];
        const responseText = await this.safeGetText(lastResponse);

        const isStreaming = await this.isResponseStreaming(page);

        // 매 15회(30초)마다 진행 로깅
        if (checkCount % 15 === 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          logger.info(`응답 수신 중... (${elapsed}초, 길이: ${responseText.length}, 스트리밍: ${isStreaming})`);
        }

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
        if (error.message.includes('ChatGPT 오류') || error.message.includes('응답 요소를 찾을 수 없습니다')) {
          throw error;
        }
        logger.warn('응답 대기 중 오류', { error: error.message });
      }
    }

    throw new Error('응답 대기 시간 초과');
  }

  async checkForErrors(page) {
    try {
      const errorSelectors = [
        'div[role="alert"]',
        '.text-red-500',
        '[data-testid="error-message"]'
      ];

      for (const selector of errorSelectors) {
        const errorEl = await page.$(selector);
        if (errorEl) {
          const text = await errorEl.innerText().catch(() => '');
          if (text && (text.includes('error') || text.includes('오류') || text.includes('실패'))) {
            return text;
          }
        }
      }

      const networkError = await page.$('text="Something went wrong"');
      if (networkError) {
        return 'Something went wrong - 네트워크 오류';
      }

      // 사용량 제한 메시지 확인 (정확한 문구만 매칭)
      const limitError = await page.$('text="You\'ve reached the current usage cap"');
      if (limitError) {
        return '사용량 제한 초과';
      }

      const limitError2 = await page.$('text="사용량 제한"');
      if (limitError2) {
        return '사용량 제한 초과';
      }

      return null;
    } catch {
      return null;
    }
  }

  async isResponseStreaming(page) {
    try {
      // 스트리밍 중지 버튼 확인
      const stopSelectors = [
        'button[aria-label="Stop generating"]',
        'button[aria-label="응답 중지"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="중지"]',
      ];

      for (const selector of stopSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) return true;
        }
      }

      // 스트리밍 CSS 클래스 확인
      const typingIndicator = await page.$('.result-streaming');
      if (typingIndicator) return true;

      return false;
    } catch {
      return false;
    }
  }

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

  async tryRecoverFromError(page) {
    try {
      logger.info('오류 복구 시도');

      // 팝업/모달 닫기
      await this.dismissPopups(page);

      // 새 대화로 이동
      await page.goto(CHATGPT_URL, {
        waitUntil: 'commit',
        timeout: 60000,
      });
      await delay(3000);
      await this.waitForInputReady(page, 15000);
    } catch (error) {
      logger.warn('오류 복구 실패', { error: error.message.substring(0, 100) });
    }
  }

  cleanResponse(text) {
    if (!text) return '';

    return text
      .replace(/^Copy code\n?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ========================================
  // 새 대화 시작
  // ========================================

  async startNewChat(page = null) {
    const targetPage = page || this.mainPage;
    logger.info('새 대화 시작');

    // 방법 1: goto (commit만 기다림 - 더 관대한 대기)
    try {
      await targetPage.goto(CHATGPT_URL, {
        waitUntil: 'commit',
        timeout: 60000,
      });
      await delay(3000);

      const inputReady = await this.waitForInputReady(targetPage, 15000);
      if (inputReady) {
        const existingMessages = await targetPage.$$('div[data-message-author-role]');
        if (existingMessages.length === 0) {
          logger.info('새 대화 준비 완료 (깨끗한 상태)');
          return;
        }
        logger.warn(`새 대화에 기존 메시지 ${existingMessages.length}개 존재, 추가 대기`);
        await delay(3000);
        return;
      }
    } catch (error) {
      logger.warn('새 대화 goto 실패', { error: error.message.substring(0, 100) });
    }

    // 방법 2: 사이드바의 새 대화 버튼 클릭
    try {
      const newChatSelectors = ['a[href="/"]', 'nav a[href="/"]'];
      for (const selector of newChatSelectors) {
        const btn = await targetPage.$(selector);
        if (btn) {
          await btn.click({ timeout: 5000 });
          await delay(3000);
          const inputReady = await this.waitForInputReady(targetPage, 10000);
          if (inputReady) {
            logger.info('새 대화 준비 완료 (버튼 클릭)');
            return;
          }
        }
      }
    } catch (error) {
      logger.warn('새 대화 버튼 클릭 실패', { error: error.message.substring(0, 100) });
    }

    // 방법 3: about:blank → ChatGPT (깨끗한 상태에서 네비게이션)
    try {
      logger.warn('about:blank 경유 새 대화 시도');
      await targetPage.goto('about:blank', { timeout: 5000 });
      await delay(1000);
      await targetPage.goto(CHATGPT_URL, {
        waitUntil: 'commit',
        timeout: 60000,
      });
      await delay(3000);
      await this.waitForInputReady(targetPage, 15000);
      logger.info('새 대화 준비 완료 (about:blank 경유)');
    } catch (error) {
      logger.error('새 대화 시작 최종 실패', { error: error.message.substring(0, 100) });
      throw new Error(`새 대화 시작 실패: ${error.message}`);
    }
  }

  // ========================================
  // JSON 파싱 (기존 유지)
  // ========================================

  extractJsonString(response) {
    if (!response) return '';

    const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return response;
  }

  unescapeString(str) {
    if (!str) return str;
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  tryRepairJson(jsonString) {
    if (!jsonString) return null;

    // 방법 1: content 필드를 별도로 추출하여 재구성
    try {
      const keywordMatch = jsonString.match(/"keyword"\s*:\s*"([^"]*?)"/);
      const titleMatch = jsonString.match(/"title"\s*:\s*"([^"]*?)"/);
      const tagsMatch = jsonString.match(/"tags"\s*:\s*\[([\s\S]*?)\]/);

      let content = null;

      let contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"/);
      if (contentMatch) {
        content = contentMatch[1];
      }

      if (!content) {
        contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
        if (contentMatch) {
          content = contentMatch[1];
        }
      }

      if (!content) {
        contentMatch = jsonString.match(/"content"\s*:\s*"([\s\S]*?)"\s*,/);
        if (contentMatch) {
          content = contentMatch[1];
        }
      }

      if (keywordMatch && titleMatch && content) {
        let tags = [];
        if (tagsMatch) {
          const tagsContent = tagsMatch[1];
          const tagMatches = tagsContent.match(/"([^"]+)"/g);
          if (tagMatches) {
            tags = tagMatches.map(t => t.replace(/"/g, ''));
          }
        }

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

    logger.error('JSON 파싱 최종 실패', {
      responseLength: response.length,
      jsonStringLength: jsonString.length
    });
    throw new Error('응답 JSON 파싱 실패: 유효한 JSON 형식을 찾을 수 없습니다');
  }

  // ========================================
  // 서비스 종료
  // ========================================

  async close() {
    try {
      // 열려있는 모든 탭 닫기
      for (const [pageId] of this.pages) {
        await this.closePage(pageId);
      }

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
