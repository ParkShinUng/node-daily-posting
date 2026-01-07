import { GoogleAuth } from 'google-auth-library';
import config from '../config.js';
import logger from '../utils/logger.js';

const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';

class GoogleApiService {
  constructor() {
    this.keyFilePath = config.google.keyFilePath;
    this.authClient = null;
  }

  /**
   * Google Auth 클라이언트 초기화
   */
  async initialize() {
    if (!this.keyFilePath) {
      throw new Error('Google API 키 파일 경로가 설정되지 않았습니다. .env 파일을 확인하세요.');
    }

    try {
      const auth = new GoogleAuth({
        keyFile: this.keyFilePath,
        scopes: [INDEXING_SCOPE],
      });

      this.authClient = await auth.getClient();
      logger.info('Google API 인증 성공');
    } catch (error) {
      logger.error('Google API 인증 실패', { error: error.message });
      throw new Error(`Google API 인증 실패: ${error.message}`);
    }
  }

  /**
   * Google Search Console에 URL 색인 등록
   * @param {string} url - 색인할 URL
   * @param {string} type - 색인 유형 (URL_UPDATED | URL_DELETED)
   */
  async registerIndex(url, type = 'URL_UPDATED') {
    if (!this.authClient) {
      await this.initialize();
    }

    logger.info('Google 색인 등록 시작', { url, type });

    try {
      const accessToken = await this.authClient.getAccessToken();

      const response = await fetch(INDEXING_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken.token}`,
        },
        body: JSON.stringify({
          url,
          type,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || `HTTP ${response.status}`);
      }

      logger.info('Google 색인 등록 성공', {
        url: data.urlNotificationMetadata?.url,
        notifyTime: data.urlNotificationMetadata?.latestUpdate?.notifyTime
      });

      return data;
    } catch (error) {
      logger.error('Google 색인 등록 실패', { url, error: error.message });
      throw new Error(`Google 색인 등록 실패: ${error.message}`);
    }
  }

  /**
   * 여러 URL 일괄 색인 등록
   * @param {string[]} urls - 색인할 URL 배열
   */
  async registerIndexBatch(urls) {
    const results = [];

    for (const url of urls) {
      try {
        const result = await this.registerIndex(url);
        results.push({ url, success: true, data: result });
      } catch (error) {
        results.push({ url, success: false, error: error.message });
      }
    }

    return results;
  }
}

export default GoogleApiService;
