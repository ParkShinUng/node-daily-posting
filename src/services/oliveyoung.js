import BrowserManager from '../utils/browser.js';
import logger from '../utils/logger.js';
import { delay, retryWithBackoff } from '../utils/helpers.js';

class OliveyoungService {
  constructor() {
    this.browserManager = new BrowserManager();
    this.page = null;
  }

  /**
   * 브라우저 초기화
   */
  async initialize() {
    logger.info('올리브영 서비스 초기화');
    await this.browserManager.launch('oliveyoung');
    this.page = await this.browserManager.newPage();
    return this;
  }

  /**
   * 카테고리별 1위 상품 정보 추출 (재시도 포함)
   * @param {string} categoryKey - 카테고리 키
   * @param {string} categoryUrl - 카테고리 전체 URL
   */
  async getTopProduct(categoryKey, categoryUrl) {
    return retryWithBackoff(
      () => this._fetchProduct(categoryKey, categoryUrl),
      {
        maxRetries: 3,
        initialDelay: 2000,
        taskName: `올리브영 ${categoryKey}`
      }
    );
  }

  /**
   * 실제 상품 정보 추출
   */
  async _fetchProduct(categoryKey, categoryUrl) {
    logger.info('올리브영 랭킹 페이지 접속', { category: categoryKey });

    await this.page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(1500);

    const productInfo = await this.page.evaluate(() => {
      const firstProduct = document.querySelector('.prd_info');
      if (!firstProduct) return null;

      const brand = firstProduct.querySelector('.tx_brand')?.textContent?.trim() || '';
      const productName = firstProduct.querySelector('.tx_name')?.textContent?.trim() || '';

      return { brand, productName };
    });

    if (!productInfo || !productInfo.brand || !productInfo.productName) {
      throw new Error('상품 정보를 찾을 수 없습니다.');
    }

    logger.info('상품 정보 추출 성공', { category: categoryKey, ...productInfo });

    return { category: categoryKey, ...productInfo };
  }

  /**
   * 전체 카테고리 상품 정보 수집 (순차 - 브라우저 공유)
   * @param {Object} categories - { key: url } 형태의 카테고리 객체
   */
  async getAllProducts(categories) {
    const entries = Object.entries(categories);
    logger.info(`총 ${entries.length}개 카테고리 상품 정보 수집 시작`);

    const products = [];
    const failures = [];

    for (const [key, url] of entries) {
      try {
        const product = await this.getTopProduct(key, url);
        products.push(product);
      } catch (error) {
        failures.push({ category: key, error: error.message });
        logger.error(`카테고리 수집 실패: ${key}`, { error: error.message });
      }

      // 카테고리 간 짧은 대기
      await delay(500);
    }

    logger.info(`상품 정보 수집 완료: 성공 ${products.length}개, 실패 ${failures.length}개`);

    return { products, failures };
  }

  /**
   * 서비스 종료
   */
  async close() {
    await this.browserManager.close(false);
    logger.info('올리브영 서비스 종료');
  }
}

export default OliveyoungService;
