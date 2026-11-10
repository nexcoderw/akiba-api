import { HealthService } from '../../src/modules/health/health.service.js';

describe('HealthService', () => {
	it('reports process liveness without claiming dependency readiness', () => {
		const result = new HealthService().getLiveness();

		expect(result.status).toBe('ok');
		expect(result.service).toBe('akiba-api');
		expect(result.version).toBe('0.1.0');
		expect(typeof result.timestamp).toBe('string');
		expect(typeof result.uptimeSeconds).toBe('number');
		expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
	});
});
