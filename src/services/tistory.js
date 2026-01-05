import BrowserManager from '../utils/browser.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const TISTORY_URL = 'https://www.tistory.com';
const TISTORY_LOGIN_URL = 'https://www.tistory.com/auth/login';
const SESSION_NAME = 'tistory';

class TistoryService {
  constructor() {
    this.browserManager = new BrowserManager();
    this.page = null;
    this.request = null;
    this.blogName = config.tistory.blogName;
  }

  /**
   * Tistory 서비스 초기화 및 로그인
   */
  async initialize() {
    logger.info('Tistory 서비스 초기화 시작');

    await this.browserManager.launch(SESSION_NAME);
    this.page = await this.browserManager.newPage();
    this.request = this.browserManager.getRequestContext();

    logger.info('로그인 진행 프로세스 시작');
    await this.login();

    return this;
  }

  /**
   * 로그인 상태 확인
   */
  async checkLoginStatus() {
    try {
      // 로그인된 상태면 사용자 메뉴가 있음
      const userMenu = await this.page.$('.my_tistory, .btn_logout, [class*="user"], .menu_profile');
      return userMenu !== null;
    } catch {
      return false;
    }
  }

  /**
   * Tistory 로그인 (카카오 계정)
   */
  async login() {
    if (!config.tistory.email || !config.tistory.password) {
      throw new Error('Tistory 로그인 정보가 설정되지 않았습니다. .env 파일을 확인하세요.');
    }

    try {
      await this.page.goto(TISTORY_LOGIN_URL, { waitUntil: 'domcontentloaded' });

      if ((await this.page.locator("a.btn_login").count()) > 0) {
        await this.page.click("a.btn_login");
        await this.page.waitForLoadState("domcontentloaded");

        await this.page.fill('input[name="loginId"]', config.tistory.email);
        await this.page.fill('input[name="password"]', config.tistory.password);
        await this.page.click('button[type="submit"]');

        await this.page.waitForLoadState("domcontentloaded");
        await this.page.waitForTimeout(3000);

        // 로그인 완료 대기 (타임아웃 5분)
        const timeout = 300000;
        const startTime = Date.now();
        while (!this.page.url().startsWith(TISTORY_URL)) {
          if (Date.now() - startTime > timeout) {
            throw new Error('Tistory 로그인 완료 대기 시간 초과');
          }
          await this.page.waitForTimeout(100);
        }

        // 세션 저장
        await this.browserManager.saveSession();
      }

      logger.info('Tistory 로그인 성공');
    } catch (error) {
      logger.error('Tistory 로그인 실패', { error: error.message });
      throw new Error(`Tistory 로그인 실패: ${error.message}`);
    }
  }

  async createPostHeaders() {
    const userAgent = await this.page.evaluate(() => navigator.userAgent);
    const fullDomain = `https://${this.blogName}.tistory.com`;

    // Playwright context.request는 쿠키를 자동으로 포함하므로 Cookie 헤더 불필요
    // Host 헤더도 URL에서 자동 설정되므로 제거 (수동 설정 시 404 발생)
    const headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR",
        "User-Agent": userAgent,
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": fullDomain,
        "Referer": `${fullDomain}/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F`,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    };

    return headers;
  }

  /**
   * 글 발행 (context.request 사용)
   */
  async writePost({ title, content, tags = [], categoryId = '0', visibility = '0' }) {
    logger.info('글 발행 시작', { title, tagsCount: tags.length });

    try {
      const headers = await this.createPostHeaders();

      // 발행 상태 매핑: 0=비공개, 20=공개
      const publishStatus = visibility === '0' ? '0' : '20';

      // 글쓰기 API 엔드포인트
      const postApiUrl = `https://${this.blogName}.tistory.com/manage/post.json`;

      const payload = {
        "id": "0",
        "title": title,
        "content": content,
        "slogan": title,
        "visibility": publishStatus,
        "category": categoryId,
        "tag": tags.join(','),
        "published": 1,
        "password": '',
        "uselessMarginForEntry": 1,
        "daumLike": "401",
        "cclCommercial": 0,
        "cclDerive": 0,
        "type": "post",
        "attachments": [],
        "recaptchaValue": "",
        "draftSequence": null
      }

      // context.request.post로 글 발행
      const response = await this.request.post(postApiUrl, {
        headers,
        data: payload,
      });

      const responseData = await response.json().catch(() => null);

      if (response.ok() && responseData) {
        const postId = responseData.postId || responseData.entryId;
        if (!postId) {
          throw new Error('API 응답에서 postId를 찾을 수 없습니다.');
        }
        const postUrl = `https://${this.blogName}.tistory.com/${postId}`;

        logger.info('글 발행 성공', { postId, url: postUrl });

        return {
          postId: postId,
          url: postUrl,
        };
      }
      else {
        throw new Error('API 방식 실패');
      }
    } catch (error) {
      logger.error('글 발행 실패', { error: error.message });
      throw new Error(`글 발행 실패: ${error.message}`);
    }
  }

  /**
   * 서비스 종료
   */
  async close() {
    await this.browserManager.close(true);
    logger.info('Tistory 서비스 종료');
  }
}

export default TistoryService;
