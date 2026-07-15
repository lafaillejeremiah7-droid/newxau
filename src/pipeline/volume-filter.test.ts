/**
 * Tests for the Volume Filter and Zone Classifier.
 *
 * Tests cover:
 * - Volume rejection when below 20-period SMA (Requirement 9.1)
 * - Expansion_Zone classification (Requirement 9.2)
 * - Chop_Zone classification (Requirement 9.3)
 * - Default Chop_Zone when neither condition met (Requirement 9.4)
 */

import { describe, it, expect } from 'vitest';
import { createVolumeFilter } from './volume-filter.js';

describe('VolumeFilter', () => {
  const filter = createVolumeFilter();

  describe('Volume Rejection (Requirement 9.1)', () => {
    it('should reject when current volume is below 20-period SMA', () => {
      const result = filter.evaluate(100, 200, [150, 160, 170, 180, 190]);

      expect(result.passed).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe('Volume below 20-period SMA');
    });

    it('should not reject when current volume equals 20-period SMA', () => {
      const result = filter.evaluate(200, 200, [150, 160, 170, 180, 190]);

      expect(result.passed).toBe(true);
      expect(result.rejected).toBe(false);
      expect(result.rejectionReason).toBeNull();
    });

    it('should not reject when current volume is above 20-period SMA', () => {
      const result = filter.evaluate(300, 200, [150, 160, 170, 180, 190]);

      expect(result.passed).toBe(true);
      expect(result.rejected).toBe(false);
      expect(result.rejectionReason).toBeNull();
    });

    it('should reject when current volume is just below SMA', () => {
      const result = filter.evaluate(199.99, 200, [100, 100, 100, 100, 100]);

      expect(result.passed).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe('Volume below 20-period SMA');
    });
  });

  describe('Expansion_Zone Classification (Requirement 9.2)', () => {
    it('should classify as expansion_zone when 3 consecutive pairs are increasing', () => {
      // Volumes: [100, 200, 300, 400, 350] → pairs: +, +, +, - → 3 increasing
      const result = filter.evaluate(500, 200, [100, 200, 300, 400, 350]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });

    it('should classify as expansion_zone when all 4 pairs are increasing', () => {
      // Volumes: [100, 200, 300, 400, 500] → pairs: +, +, +, + → 4 increasing
      const result = filter.evaluate(600, 200, [100, 200, 300, 400, 500]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });

    it('should classify as expansion_zone with exactly 3 increasing pairs (first 3)', () => {
      // Volumes: [100, 200, 300, 400, 400] → pairs: +, +, +, = → 3 increasing
      const result = filter.evaluate(500, 200, [100, 200, 300, 400, 400]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });

    it('should classify as expansion_zone with 3 non-consecutive increasing pairs', () => {
      // Volumes: [100, 200, 150, 300, 400] → pairs: +, -, +, + → 3 increasing
      const result = filter.evaluate(500, 200, [100, 200, 150, 300, 400]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
      expect(result.partialProfitAt).toBe(0.35);
    });
  });

  describe('Chop_Zone Classification (Requirement 9.3)', () => {
    it('should classify as chop_zone with 1.5R when 3 consecutive pairs are decreasing', () => {
      // Volumes: [500, 400, 300, 200, 250] → pairs: -, -, -, + → 3 decreasing
      const result = filter.evaluate(300, 200, [500, 400, 300, 200, 250]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(1.5);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should classify as chop_zone with 1.5R when all 4 pairs are decreasing', () => {
      // Volumes: [500, 400, 300, 200, 100] → pairs: -, -, -, - → 4 decreasing
      const result = filter.evaluate(300, 200, [500, 400, 300, 200, 100]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(1.5);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should classify as chop_zone with 3 non-consecutive decreasing pairs', () => {
      // Volumes: [500, 400, 450, 300, 200] → pairs: -, +, -, - → 3 decreasing
      const result = filter.evaluate(300, 200, [500, 400, 450, 300, 200]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(1.5);
      expect(result.partialProfitAt).toBeNull();
    });
  });

  describe('Default Chop_Zone Classification (Requirement 9.4)', () => {
    it('should default to chop_zone with 2.0R when neither condition met', () => {
      // Volumes: [100, 200, 100, 200, 100] → pairs: +, -, +, - → 2 increasing, 2 decreasing
      const result = filter.evaluate(300, 200, [100, 200, 100, 200, 100]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(2.0);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should default to chop_zone with 2.0R when only 2 pairs are increasing', () => {
      // Volumes: [100, 200, 300, 200, 100] → pairs: +, +, -, - → 2 increasing, 2 decreasing
      const result = filter.evaluate(300, 200, [100, 200, 300, 200, 100]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(2.0);
      expect(result.partialProfitAt).toBeNull();
    });

    it('should default to chop_zone with 2.0R when volumes are all equal', () => {
      // Volumes: [200, 200, 200, 200, 200] → pairs: =, =, =, = → 0 increasing, 0 decreasing
      const result = filter.evaluate(300, 200, [200, 200, 200, 200, 200]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('chop_zone');
      expect(result.targetRMultiple).toBe(2.0);
      expect(result.partialProfitAt).toBeNull();
    });
  });

  describe('Expansion_Zone priority over Chop_Zone', () => {
    it('should classify as expansion_zone when both 3 increasing and 3 decreasing pairs exist (impossible with 5 candles / 4 pairs, but edge case)', () => {
      // With 5 candles there are only 4 pairs, so it's impossible to have both ≥3 increasing and ≥3 decreasing
      // Testing that expansion takes priority when ≥3 increasing
      // Volumes: [100, 200, 300, 400, 350] → pairs: +, +, +, - → 3 increasing, 1 decreasing
      const result = filter.evaluate(500, 200, [100, 200, 300, 400, 350]);

      expect(result.zoneClassification).toBe('expansion_zone');
    });
  });

  describe('Result structure completeness', () => {
    it('should return all required fields when rejected', () => {
      const result = filter.evaluate(50, 200, [100, 200, 300, 400, 500]);

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('rejected');
      expect(result).toHaveProperty('rejectionReason');
      expect(result).toHaveProperty('zoneClassification');
      expect(result).toHaveProperty('targetRMultiple');
      expect(result).toHaveProperty('partialProfitAt');
    });

    it('should return all required fields when passed with expansion zone', () => {
      const result = filter.evaluate(500, 200, [100, 200, 300, 400, 500]);

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('rejected');
      expect(result).toHaveProperty('rejectionReason');
      expect(result).toHaveProperty('zoneClassification');
      expect(result).toHaveProperty('targetRMultiple');
      expect(result).toHaveProperty('partialProfitAt');
    });
  });

  describe('Edge cases', () => {
    it('should handle volumes with very small differences', () => {
      // Volumes: [100.001, 100.002, 100.003, 100.004, 100.005] → all increasing
      const result = filter.evaluate(300, 200, [100.001, 100.002, 100.003, 100.004, 100.005]);

      expect(result.passed).toBe(true);
      expect(result.zoneClassification).toBe('expansion_zone');
      expect(result.targetRMultiple).toBe(3.0);
    });

    it('should handle volume exactly equal to SMA (not rejected)', () => {
      const result = filter.evaluate(200, 200, [100, 200, 300, 400, 500]);

      expect(result.passed).toBe(true);
      expect(result.rejected).toBe(false);
    });

    it('should handle zero volume (below any positive SMA)', () => {
      const result = filter.evaluate(0, 200, [100, 200, 300, 400, 500]);

      expect(result.passed).toBe(false);
      expect(result.rejected).toBe(true);
    });
  });
});
