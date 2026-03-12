import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import OliveyoungService from './services/oliveyoung.js';
import ChatGPTService from './services/chatgpt.js';
import TistoryService from './services/tistory.js';
import { orchestrate } from './orchestrator.js';
import config from './config.js';
import logger from './utils/logger.js';

// 활성 카테고리 설정 (빈 배열이면 전체 카테고리 실행)
const ACTIVE_CATEGORIES = ['skincare', 'makeup'];

/**
 * 랭킹 URL 카테고리 로드
 */
function loadRankCategories() {
  const rankUrlPath = join(config.paths.config, 'lankUrl.json');

  if (!existsSync(rankUrlPath)) {
    throw new Error('config/lankUrl.json 파일이 없습니다.');
  }

  const data = readFileSync(rankUrlPath, 'utf-8');
  const all = JSON.parse(data);

  if (ACTIVE_CATEGORIES.length === 0) return all;

  const filtered = {};
  for (const key of ACTIVE_CATEGORIES) {
    if (all[key]) filtered[key] = all[key];
  }
  return filtered;
}

/**
 * 결과 요약 출력
 */
function printSummary(results) {
  logger.info('');
  logger.info('========================================');
  logger.info('           작업 결과 요약');
  logger.info('========================================');

  const successResults = results.filter(r => r.success);
  const failResults = results.filter(r => !r.success);

  logger.info(`총 처리: ${results.length}개`);
  logger.info(`성공: ${successResults.length}개`);
  logger.info(`실패: ${failResults.length}개`);
  logger.info('');

  if (successResults.length > 0) {
    logger.info('[ 성공 목록 ]');
    successResults.forEach((r, i) => {
      logger.info(`  ${i + 1}. ${r.category}: ${r.title}`);
      logger.info(`     URL: ${r.postUrl}`);
    });
  }

  if (failResults.length > 0) {
    logger.info('');
    logger.info('[ 실패 목록 ]');
    failResults.forEach((r, i) => {
      logger.error(`  ${i + 1}. ${r.category}: ${r.error}`);
    });
  }

  logger.info('========================================');
}

/**
 * 메인 실행 로직
 */
async function main() {
  let oliveyoung = null;
  let chatgpt = null;
  let tistory = null;
  const allResults = [];

  const startTime = Date.now();

  try {
    logger.info('========================================');
    logger.info('   올리브영 멀티 에이전트 자동 포스팅');
    logger.info('========================================');
    logger.info('');

    // ========================================
    // STEP 1: 올리브영 상품 정보 수집
    // ========================================
    logger.info('[STEP 1/4] 올리브영 상품 정보 수집');
    logger.info('----------------------------------------');

    const categories = loadRankCategories();
    oliveyoung = new OliveyoungService();
    await oliveyoung.initialize();
    const { products, failures: collectionFailures } = await oliveyoung.getAllProducts(categories);
    await oliveyoung.close();
    oliveyoung = null;

    if (products.length === 0) {
      throw new Error('수집된 상품 정보가 없습니다.');
    }

    // 수집 실패 카테고리 기록
    collectionFailures.forEach(f => {
      allResults.push({
        category: f.category,
        success: false,
        error: `상품 정보 수집 실패: ${f.error}`
      });
    });

    logger.info(`수집 완료: ${products.length}개 상품`);
    products.forEach(p => {
      logger.info(`  - ${p.category}: ${p.brand} ${p.productName}`);
    });
    logger.info('');

    // ========================================
    // STEP 2: 서비스 초기화
    // ========================================
    logger.info('[STEP 2/4] 서비스 초기화');
    logger.info('----------------------------------------');

    // ChatGPT 초기화 (로그인)
    chatgpt = new ChatGPTService();
    await chatgpt.initialize();

    // Tistory 초기화
    tistory = new TistoryService();
    await tistory.initialize();

    logger.info('모든 서비스 초기화 완료');
    logger.info('');

    // ========================================
    // STEP 3: 카테고리별 병렬 오케스트레이터
    // ========================================
    logger.info('[STEP 3/4] 카테고리별 순차 포스팅 시작');
    logger.info('----------------------------------------');
    logger.info(`${products.length}개 카테고리를 순차 처리합니다.`);
    logger.info('  각 카테고리: ChatGPT 탭 2개 (글 작성 ∥ 이미지+썸네일 병렬)');
    logger.info('');

    // 카테고리별 순차 처리 (ChatGPT 탭 동시 4개 → 2개로 제한)
    for (const product of products) {
      logger.info(`[${product.category}] 포스팅 시작`);
      try {
        const result = await orchestrate({
          product,
          chatgptService: chatgpt,
          tistoryService: tistory,
        });
        allResults.push(result);
      } catch (error) {
        allResults.push({
          category: product.category,
          success: false,
          error: error.message || '알 수 없는 오류',
        });
      }
    }

    logger.info('');

    // ========================================
    // STEP 4: 결과 요약
    // ========================================
    logger.info('[STEP 4/4] 작업 완료');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info(`총 소요 시간: ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`);

    printSummary(allResults);

  } catch (error) {
    logger.error('치명적 오류 발생', { error: error.message });
    printSummary(allResults);
    process.exit(1);
  } finally {
    // 서비스 종료
    logger.info('');
    logger.info('서비스 종료 중...');

    if (oliveyoung) {
      try {
        await oliveyoung.close();
      } catch (e) {
        logger.error('올리브영 종료 실패', { error: e.message });
      }
    }

    if (chatgpt) {
      try {
        await chatgpt.close();
      } catch (e) {
        logger.error('ChatGPT 종료 실패', { error: e.message });
      }
    }

    if (tistory) {
      try {
        await tistory.close();
      } catch (e) {
        logger.error('Tistory 종료 실패', { error: e.message });
      }
    }

    logger.info('모든 서비스 종료 완료');
  }
}

// 실행
main().then(() => {
  process.exit(0);
}).catch((error) => {
  logger.error('예상치 못한 오류', { error: error.message });
  process.exit(1);
});
