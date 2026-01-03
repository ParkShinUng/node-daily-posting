import BrowserManager from '../utils/browser.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const TISTORY_URL = 'https://www.tistory.com';
const TISOTRY_LOGIN_URL = 'https://www.tistory.com/auth/login';
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

    // Tistory 접속
    await this.page.goto(TISTORY_URL, { waitUntil: 'domcontentloaded' });
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
      await this.page.goto(TISOTRY_LOGIN_URL, { waitUntil: 'domcontentloaded' });

      if ((await this.page.locator("a.btn_login").count()) > 0) {
        await this.page.click("a.btn_login");
        await this.page.waitForLoadState("domcontentloaded");

        await this.page.fill('input[name="loginId"]', config.tistory.email);
        await this.page.fill('input[name="password"]', config.tistory.password);
        await this.page.click('button[type="submit"]');

        await this.page.waitForLoadState("domcontentloaded");
        await this.page.waitForTimeout(3000);
        const descLogin = await this.page.locator('p.desc_login', { hasText: '카카오톡으로 로그인 확인 메세지가 전송되었습니다.' });
        if (await descLogin.count() > 0) {
          emit({ event: "log", message: "Request Login Auth" });
        }

        while (!this.page.url().includes("www.tistory.com/")) {
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
    const fullDomain = `${this.blogName}.tistory.com`;

    // Playwright context.request는 쿠키를 자동으로 포함하므로 Cookie 헤더 불필요
    // Host 헤더도 URL에서 자동 설정되므로 제거 (수동 설정 시 404 발생)
    const headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR",
        "User-Agent": userAgent,
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": `https://${fullDomain}`,
        "Referer": `https://${fullDomain}/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F`,
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
        headers: {
          "content-type": "application/json; charset=utf-8",
          "accept": "application/json, text/plain, */*",
          ...headers,
        },
        data: payload,
      });

      const responseData = await response.json().catch(() => null);

      if (response.ok() && responseData) {
        const postId = responseData.postId || responseData.entryId;
        const postUrl = `https://${this.blogName}.tistory.com/${postId}`;

        logger.info('글 발행 성공', { postId, url: postUrl });

        return {
          postId: postId,
          url: postUrl,
        };
      }

      // 대체 방법: 페이지에서 직접 폼 제출
      logger.info('API 방식 실패, 페이지 폼 제출 방식 시도');
      return await this.writePostViaPage({ title, content, tags, categoryId, visibility });

    } catch (error) {
      logger.error('글 발행 실패', { error: error.message });
      throw new Error(`글 발행 실패: ${error.message}`);
    }
  }

  /**
   * 페이지에서 직접 폼 제출하여 글 발행
   */
  async writePostViaPage({ title, content, tags, categoryId, visibility }) {
    const writeUrl = `https://${this.blogName}.tistory.com/manage/newpost`;
    await this.page.goto(writeUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // 제목 입력
    const titleInput = await this.page.waitForSelector('#post-title-inp, input[name="title"], .title-input');
    await titleInput.fill(title);

    // 카테고리 선택
    if (categoryId && categoryId !== '0') {
      const categorySelect = await this.page.$('select#category, select[name="category"]');
      if (categorySelect) {
        await categorySelect.selectOption(categoryId);
      }
    }

    // 본문 입력 (에디터 타입에 따라 다름)
    await this.fillContent(content);

    // 태그 입력
    if (tags.length > 0) {
      await this.fillTags(tags);
    }

    // 공개 설정
    if (visibility === '0') {
      const privateRadio = await this.page.$('input[name="visibility"][value="0"], #visibility-private');
      if (privateRadio) await privateRadio.click();
    }

    // 발행 버튼 클릭
    const publishButton = await this.page.waitForSelector('button.btn_publish, button#publish-btn, button:has-text("발행")');
    await publishButton.click();

    await this.page.waitForTimeout(5000);

    // 발행 후 URL에서 포스트 ID 추출
    const currentUrl = this.page.url();
    const postIdMatch = currentUrl.match(/\/(\d+)$/);
    const postId = postIdMatch ? postIdMatch[1] : 'unknown';

    return {
      postId,
      url: currentUrl.includes('/manage') ? `https://${this.blogName}.tistory.com/${postId}` : currentUrl,
    };
  }

  /**
   * 본문 내용 입력
   */
  async fillContent(content) {
    // 에디터 iframe 확인
    const editorFrame = await this.page.$('iframe#editor-iframe, iframe.editor');

    if (editorFrame) {
      const frame = await editorFrame.contentFrame();
      if (frame) {
        const body = await frame.waitForSelector('body');
        await body.click();
        await frame.evaluate((html) => {
          document.body.innerHTML = html;
        }, content);
        return;
      }
    }

    // contenteditable 에디터
    const editableArea = await this.page.$('[contenteditable="true"], .editor-content, #content');
    if (editableArea) {
      await editableArea.click();
      await this.page.evaluate((html) => {
        const editor = document.querySelector('[contenteditable="true"], .editor-content, #content');
        if (editor) editor.innerHTML = html;
      }, content);
      return;
    }

    // textarea 에디터
    const textarea = await this.page.$('textarea#content, textarea.content');
    if (textarea) {
      await textarea.fill(content);
    }
  }

  /**
   * 태그 입력
   */
  async fillTags(tags) {
    const tagInput = await this.page.$('input#tag-inp, input[name="tag"], .tag-input');
    if (tagInput) {
      await tagInput.fill(tags.join(', '));
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
