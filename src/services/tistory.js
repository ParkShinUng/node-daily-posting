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
   * 이미지 업로드 → Tistory CDN URL 반환
   * @param {Buffer} imageBuffer - 이미지 바이너리 데이터
   * @param {string} filename - 파일명
   * @returns {string} Tistory CDN 이미지 URL
   */
  async uploadImage(imageBuffer, filename = 'image.png') {
    logger.info('이미지 업로드 시작', { filename, size: imageBuffer.length });

    try {
      const uploadUrl = `https://${this.blogName}.tistory.com/manage/post/attach.json`;

      // 방법 1: Playwright APIRequestContext (Filedata 필드명)
      const fieldNames = ['Filedata', 'file', 'upload'];
      let lastError = null;

      for (const fieldName of fieldNames) {
        try {
          const response = await this.request.post(uploadUrl, {
            multipart: {
              [fieldName]: {
                name: filename,
                mimeType: 'image/png',
                buffer: imageBuffer,
              },
            },
          });

          if (response.ok()) {
            const data = await response.json();
            const imageUrl = data.url || data.replacer || (data.attachments && data.attachments[0]?.url);

            if (imageUrl) {
              logger.info('이미지 업로드 성공', { imageUrl, fieldName });
              return imageUrl;
            }
            logger.warn('업로드 응답에서 URL 추출 실패', { data: JSON.stringify(data).substring(0, 500), fieldName });
          } else {
            logger.warn(`업로드 실패 (필드: ${fieldName})`, { status: response.status() });
          }
        } catch (err) {
          lastError = err;
          logger.warn(`업로드 시도 실패 (필드: ${fieldName})`, { error: err.message });
        }
      }

      // 방법 2: 페이지 컨텍스트에서 fetch 사용 (인증 쿠키 포함)
      logger.info('페이지 컨텍스트로 업로드 재시도');
      try {
        // Tistory 관리 페이지로 이동 (인증 컨텍스트 확보)
        const currentUrl = this.page.url();
        if (!currentUrl.includes('tistory.com/manage')) {
          await this.page.goto(`https://${this.blogName}.tistory.com/manage`, {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
        }

        const data = await this.page.evaluate(async ({ url, bufferArray, name }) => {
          const formData = new FormData();
          const blob = new Blob([new Uint8Array(bufferArray)], { type: 'image/png' });
          formData.append('Filedata', blob, name);

          const res = await fetch(url, { method: 'POST', body: formData });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        }, { url: uploadUrl, bufferArray: [...imageBuffer], name: filename });

        const imageUrl = data.url || data.replacer || (data.attachments && data.attachments[0]?.url);
        if (imageUrl) {
          logger.info('이미지 업로드 성공 (페이지 컨텍스트)', { imageUrl });
          return imageUrl;
        }
      } catch (err) {
        lastError = err;
        logger.warn('페이지 컨텍스트 업로드 실패', { error: err.message });
      }

      throw lastError || new Error('모든 업로드 방법 실패');
    } catch (error) {
      logger.error('이미지 업로드 실패', { error: error.message });
      throw new Error(`이미지 업로드 실패: ${error.message}`);
    }
  }

  /**
   * 글 발행 (이미지 썸네일 지원)
   */
  async writePost({ title, content, tags = [], categoryId = '0', visibility = '0', thumbnailUrl = '' }) {
    logger.info('글 발행 시작', { title, tagsCount: tags.length, hasThumbnail: !!thumbnailUrl });

    try {
      const headers = await this.createPostHeaders();

      // 발행 상태 매핑: 0=비공개, 20=공개
      const publishStatus = visibility === '0' ? '0' : '20';

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
        "daumLike": "112",
        "cclCommercial": 0,
        "cclDerive": 0,
        "type": "post",
        "attachments": [],
        "recaptchaValue": "",
        "draftSequence": null
      };

      // 썸네일 URL이 있으면 대표 이미지 설정
      if (thumbnailUrl) {
        payload.thumbnail = thumbnailUrl;
      }

      const response = await this.request.post(postApiUrl, {
        headers,
        data: payload,
      });

      if (response.ok()) {
        const responseData = await response.json();
        const postUrl = responseData.entryUrl;

        logger.info('글 발행 성공', { postUrl });
        return postUrl;
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
