import logger from './logger.js';

/**
 * 지정된 시간만큼 대기
 * @param {number} ms - 대기 시간 (밀리초)
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 재시도 로직이 포함된 함수 실행
 * @param {Function} fn - 실행할 비동기 함수
 * @param {Object} options - 옵션
 * @param {number} options.maxRetries - 최대 재시도 횟수 (기본값: 3)
 * @param {number} options.initialDelay - 초기 대기 시간 ms (기본값: 1000)
 * @param {number} options.maxDelay - 최대 대기 시간 ms (기본값: 30000)
 * @param {string} options.taskName - 작업 이름 (로깅용)
 */
export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    taskName = 'Task'
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        logger.error(`${taskName} 최종 실패 (${attempt}/${maxRetries})`, { error: error.message });
        throw error;
      }

      // Exponential backoff with jitter
      const backoffDelay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = Math.random() * 1000;
      const totalDelay = backoffDelay + jitter;

      logger.warn(`${taskName} 실패, ${Math.round(totalDelay / 1000)}초 후 재시도 (${attempt}/${maxRetries})`, {
        error: error.message
      });

      await delay(totalDelay);
    }
  }

  throw lastError;
}
