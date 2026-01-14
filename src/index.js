import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import OliveyoungService from './services/oliveyoung.js';
import ChatGPTService from './services/chatgpt.js';
import TistoryService from './services/tistory.js';
import GoogleApiService from './services/googleApi.js';
import config from './config.js';
import logger from './utils/logger.js';
import { delay } from './utils/helpers.js';

// 설정 상수
const CATEGORY_DELAY = 3000; // 카테고리 간 대기 시간 (ms)

/**
 * 프롬프트 템플릿 로드
 */
function loadPromptTemplate() {
  const promptsPath = join(config.paths.config, 'prompts.json');

  if (!existsSync(promptsPath)) {
    throw new Error('config/prompts.json 파일이 없습니다.');
  }

  const data = readFileSync(promptsPath, 'utf-8');
  const prompts = JSON.parse(data).lank_item_prompts || [];

  if (prompts.length === 0) {
    throw new Error('설정된 프롬프트가 없습니다.');
  }

  return prompts[0].prompt;
}

/**
 * 랭킹 URL 카테고리 로드
 */
function loadRankCategories() {
  const rankUrlPath = join(config.paths.config, 'lankUrl.json');

  if (!existsSync(rankUrlPath)) {
    throw new Error('config/lankUrl.json 파일이 없습니다.');
  }

  const data = readFileSync(rankUrlPath, 'utf-8');
  return JSON.parse(data);
}

/**
 * 프롬프트에 변수 대입
 */
function buildPrompt(template, brandName, productName) {
  return template
    .replace(/{브랜드명}/g, brandName)
    .replace(/{상품명}/g, productName);
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
      logger.info(`  ${i + 1}. ${r.category}: ${r.postUrl}`);
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
  const results = [];

  const startTime = Date.now();

  try {
    logger.info('========================================');
    logger.info('   올리브영 + ChatGPT + Tistory 자동 포스팅');
    logger.info('========================================');
    logger.info('');

    // ========================================
    // STEP 1: 데이터 수집 (병렬)
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

    // 수집 실패한 카테고리 결과에 추가
    collectionFailures.forEach(f => {
      results.push({
        category: f.category,
        success: false,
        error: `상품 정보 수집 실패: ${f.error}`
      });
    });

    logger.info('');

    // ========================================
    // STEP 2: 서비스 초기화
    // ========================================
    logger.info('[STEP 2/4] 서비스 초기화');
    logger.info('----------------------------------------');

    // 프롬프트 템플릿 로드
    const promptTemplate = loadPromptTemplate();
    logger.info('프롬프트 템플릿 로드 완료');

    // ChatGPT 초기화
    chatgpt = new ChatGPTService();
    await chatgpt.initialize();

    // Tistory 초기화
    tistory = new TistoryService();
    await tistory.initialize();

    // Google API 초기화
    const googleApi = new GoogleApiService();

    logger.info('모든 서비스 초기화 완료');
    logger.info('');

    // ========================================
    // STEP 3: 글 생성 및 발행
    // ========================================
    logger.info('[STEP 3/4] 글 생성 및 발행');
    logger.info('----------------------------------------');

    const indexPromises = []; // 색인 요청 Promise 수집

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const progress = `[${i + 1}/${products.length}]`;

      logger.info('');
      logger.info(`${progress} === ${product.category} ===`);
      logger.info(`${progress} 브랜드: ${product.brand}`);
      logger.info(`${progress} 상품: ${product.productName}`);

      try {
        // 새 대화 시작 (첫 번째 제외)
        if (i > 0) {
          await chatgpt.startNewChat();
        }

        // 프롬프트 빌드 및 전송
        const prompt = buildPrompt(promptTemplate, product.brand, product.productName);
        logger.info(`${progress} ChatGPT 글 생성 중...`);

        const response = await chatgpt.sendPrompt(prompt);
        const post = chatgpt.parseResponse(response);

        logger.info(`${progress} 제목: ${post.title}`);

        // Tistory 발행 + Google 색인 병렬 처리
        logger.info(`${progress} Tistory 발행 + Google 색인 요청 (병렬)...`);
        post.visibility = '20';
        post.categoryId = '1292960';

        const postUrl = await tistory.writePost(post);

        // 색인 요청은 백그라운드로 진행 (다음 카테고리와 병렬)
        const indexPromise = googleApi.registerIndex(postUrl)
          .then(() => logger.info(`${progress} Google 색인 완료`))
          .catch(err => logger.warn(`${progress} Google 색인 실패`, { error: err.message }));

        indexPromises.push(indexPromise);

        results.push({
          category: product.category,
          success: true,
          postUrl,
          title: post.title
        });

        logger.info(`${progress} 발행 완료! ${postUrl}`);

      } catch (error) {
        logger.error(`${progress} 실패: ${error.message}`);
        results.push({
          category: product.category,
          success: false,
          error: error.message
        });
      }

      // 다음 카테고리 전 대기 (마지막 제외)
      if (i < products.length - 1) {
        logger.info(`${progress} 다음 작업 전 ${CATEGORY_DELAY / 1000}초 대기...`);
        await delay(CATEGORY_DELAY);
      }
    }

    logger.info('');

    // 모든 색인 요청 완료 대기
    if (indexPromises.length > 0) {
      logger.info('Google 색인 요청 완료 대기 중...');
      await Promise.allSettled(indexPromises);
      logger.info('모든 색인 요청 처리 완료');
    }

    logger.info('');

    // ========================================
    // STEP 4: 결과 요약
    // ========================================
    logger.info('[STEP 4/4] 작업 완료');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info(`총 소요 시간: ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`);

    printSummary(results);

  } catch (error) {
    logger.error('치명적 오류 발생', { error: error.message });
    printSummary(results);
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
