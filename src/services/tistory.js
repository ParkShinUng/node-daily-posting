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
    this.blogName = null;
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

    // 블로그 이름 가져오기
    await this.fetchBlogName();

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
      // 로그인 페이지로 이동
      await this.page.goto('https://www.tistory.com/auth/login', { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2000);

      // 카카오 로그인 버튼 클릭
      const kakaoButton = await this.page.waitForSelector('a.btn_login.link_kakao_id, a[href*="kakao"], .kakao_login', {
        timeout: 10000,
      });
      await kakaoButton.click();

      await this.page.waitForTimeout(3000);

      // 카카오 로그인 폼
      const emailInput = await this.page.waitForSelector('input[name="loginId"], input#loginId, input[name="email"]', {
        timeout: 15000,
      });
      await emailInput.fill(config.tistory.email);

      const passwordInput = await this.page.waitForSelector('input[name="password"], input#password', {
        timeout: 5000,
      });
      await passwordInput.fill(config.tistory.password);

      // 로그인 버튼 클릭
      const loginButton = await this.page.waitForSelector('button[type="submit"], button.submit, input[type="submit"]');
      await loginButton.click();

      // 로그인 완료 대기
      await this.page.waitForURL(/tistory\.com/, { timeout: 30000 });
      await this.page.waitForTimeout(3000);

      // 세션 저장
      await this.browserManager.saveSession();

      logger.info('Tistory 로그인 성공');
    } catch (error) {
      logger.error('Tistory 로그인 실패', { error: error.message });
      throw new Error(`Tistory 로그인 실패: ${error.message}`);
    }
  }

  /**
   * 블로그 이름 가져오기
   */
  async fetchBlogName() {
    if (config.tistory.blogName) {
      this.blogName = config.tistory.blogName;
      return;
    }

    try {
      // 내 블로그 목록 페이지에서 블로그 이름 추출
      await this.page.goto('https://www.tistory.com/member/blog', { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2000);

      const blogLink = await this.page.$('a[href*=".tistory.com"]');
      if (blogLink) {
        const href = await blogLink.getAttribute('href');
        const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
        if (match) {
          this.blogName = match[1];
          logger.info('블로그 이름 확인', { blogName: this.blogName });
        }
      }
    } catch (error) {
      logger.warn('블로그 이름 자동 감지 실패', { error: error.message });
    }

    if (!this.blogName) {
      throw new Error('블로그 이름을 확인할 수 없습니다. .env에 TISTORY_BLOG_NAME을 설정해주세요.');
    }
  }

  /**
   * 블로그 정보 조회
   */
  async getBlogInfo() {
    logger.info('블로그 정보 조회');

    const blogUrl = `https://${this.blogName}.tistory.com`;

    try {
      await this.page.goto(blogUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2000);

      const title = await this.page.title();

      return [{
        name: this.blogName,
        url: blogUrl,
        title: title,
        description: '',
      }];
    } catch (error) {
      logger.error('블로그 정보 조회 실패', { error: error.message });
      throw error;
    }
  }

  /**
   * 카테고리 목록 조회
   */
  async getCategories() {
    logger.info('카테고리 목록 조회');

    try {
      // 글쓰기 페이지에서 카테고리 정보 가져오기
      const writeUrl = `https://${this.blogName}.tistory.com/manage/newpost`;
      await this.page.goto(writeUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);

      // 카테고리 select 요소에서 옵션 추출
      const categories = await this.page.$$eval(
        'select#category option, select[name="category"] option',
        (options) => options.map(opt => ({
          id: opt.value,
          name: opt.textContent.trim(),
        })).filter(cat => cat.id && cat.id !== '0')
      );

      logger.info('카테고리 조회 성공', { count: categories.length });
      return categories;
    } catch (error) {
      logger.error('카테고리 조회 실패', { error: error.message });
      return [];
    }
  }

  /**
   * 글 발행 (context.request 사용)
   */
  async writePost({ title, content, tags = [], categoryId = '0', visibility = '3' }) {
    logger.info('글 발행 시작', { title, tagsCount: tags.length });

    try {
      // 글쓰기 페이지로 이동하여 필요한 토큰 획득
      const writeUrl = `https://${this.blogName}.tistory.com/manage/newpost`;
      await this.page.goto(writeUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);

      // 마크다운을 HTML로 변환
      const htmlContent = this.markdownToHtml(content);

      // 발행 상태 매핑: 0=비공개, 3=공개
      const publishStatus = visibility === '0' ? '0' : '3';

      // 글쓰기 API 엔드포인트
      const postApiUrl = `https://${this.blogName}.tistory.com/manage/post/write.json`;

      // context.request.post로 글 발행
      const response = await this.request.post(postApiUrl, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': writeUrl,
        },
        form: {
          title: title,
          content: htmlContent,
          category: categoryId,
          tag: tags.join(','),
          visibility: publishStatus,
          published: '',
          slogan: '',
          acceptComment: '1',
          acceptTrackback: '0',
          password: '',
        },
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
      return await this.writePostViaPage({ title, content: htmlContent, tags, categoryId, visibility });

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
   * 마크다운을 HTML로 변환
   */
  markdownToHtml(markdown) {
    if (!markdown) return '';

    let html = markdown
      // 코드 블록
      .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // 인라인 코드
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // 헤더
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // 볼드
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // 이탤릭
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // 링크
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // 이미지
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
      // 줄바꿈
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    // 리스트 처리
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // 숫자 리스트
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // 단락 래핑
    if (!html.startsWith('<')) {
      html = '<p>' + html + '</p>';
    }

    return html;
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
