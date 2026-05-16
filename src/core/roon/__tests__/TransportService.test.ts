import { TransportService } from '../TransportService';
import { RoonClient } from '../RoonClient';
import { Logger } from 'pino';
import { CoreUnpairedError, RoonOperationError } from '../errors';

// Mock RoonClient
const mockRoonClient = {
  getTransport: jest.fn(),
  getBrowse: jest.fn(),
  getImage: jest.fn(),
  getCoreInfo: jest.fn(),
  getCoreStatus: jest.fn(),
  on: jest.fn(),
  start: jest.fn(),
} as unknown as RoonClient;

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
} as unknown as Logger;

describe('TransportService', () => {
  let service: TransportService;
  let mockTransport: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTransport = {
      control: jest.fn(),
      change_volume: jest.fn(),
      change_settings: jest.fn(),
      seek: jest.fn(),
      subscribe_zones: jest.fn(),
      subscribe_queue: jest.fn(),
      play_from_here: jest.fn(),
    };
    (mockRoonClient.getTransport as jest.Mock).mockReturnValue(mockTransport);
    service = new TransportService(mockRoonClient, mockLogger);
  });

  describe('playPause', () => {
    it('should call transport.control with playpause action', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback(null);
      });

      await service.playPause('zone123');

      expect(mockTransport.control).toHaveBeenCalledWith(
        'zone123',
        'playpause',
        expect.any(Function)
      );
    });

    it('should throw CoreUnpairedError when transport unavailable', async () => {
      (mockRoonClient.getTransport as jest.Mock).mockReturnValue(null);

      await expect(service.playPause('zone123')).rejects.toThrow(CoreUnpairedError);
    });

    it('should reject with RoonOperationError on failure', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback('Roon error');
      });

      await expect(service.playPause('zone123')).rejects.toThrow(RoonOperationError);
    });
  });

  describe('next', () => {
    it('should call transport.control with next action', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback(null);
      });

      await service.next('zone123');

      expect(mockTransport.control).toHaveBeenCalledWith('zone123', 'next', expect.any(Function));
    });
  });

  describe('setVolume', () => {
    it('should call transport.change_volume with correct parameters', async () => {
      mockTransport.change_volume.mockImplementation((_outputId: string, _how: string, _value: number, callback: Function) => {
        callback(null);
      });

      await service.setVolume('output123', 50);

      expect(mockTransport.change_volume).toHaveBeenCalledWith(
        'output123',
        'absolute',
        50,
        expect.any(Function)
      );
    });
  });

  describe('getZones', () => {
    it('should return empty array when no zones subscribed', () => {
      const zones = service.getZones();
      expect(zones).toEqual([]);
    });
  });

  describe('getZone', () => {
    it('should return undefined for non-existent zone', () => {
      const zone = service.getZone('nonexistent');
      expect(zone).toBeUndefined();
    });
  });

  describe('setPlaybackSettings', () => {
    it('should call transport.change_settings with provided settings', async () => {
      mockTransport.change_settings.mockImplementation(
        (_zoneId: string, _settings: Record<string, unknown>, callback: Function) => {
          callback(null);
        }
      );

      await service.setPlaybackSettings('zone123', { shuffle: true, loop: 'loop' });

      expect(mockTransport.change_settings).toHaveBeenCalledWith(
        'zone123',
        { shuffle: true, loop: 'loop' },
        expect.any(Function)
      );
    });
  });

  describe('subscribeQueue', () => {
    it('should normalize queue items and expose queue snapshot', () => {
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', {
            items: [
              {
                queue_item_id: 7,
                one_line: { line1: 'Track 1' },
              },
            ],
          });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeQueue('zone123', 100);
      const queue = service.getQueue('zone123');

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        5000,
        expect.any(Function)
      );
      expect(queue.zone_id).toBe('zone123');
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0].queue_item_id).toBe(7);
    });

    it('should upsize queue subscription from zone metadata when available', () => {
      mockTransport.subscribe_zones.mockImplementation((callback: Function) => {
        callback('Subscribed', {
          zones: [
            {
              zone_id: 'zone123',
              display_name: 'Main Zone',
              state: 'playing',
              queue_items_remaining: 6200
            }
          ]
        });
      });

      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeZones();
      service.subscribeQueue('zone123');

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        6233,
        expect.any(Function)
      );
    });

    it('should re-subscribe when a larger queue size is requested later', () => {
      const firstUnsubscribe = jest.fn();
      const secondUnsubscribe = jest.fn();
      mockTransport.subscribe_queue
        .mockImplementationOnce((_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: firstUnsubscribe };
        })
        .mockImplementationOnce((_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: secondUnsubscribe };
        });

      service.subscribeQueue('zone123', 5000);
      service.subscribeQueue('zone123', 9000);

      expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockTransport.subscribe_queue).toHaveBeenNthCalledWith(
        1,
        'zone123',
        5000,
        expect.any(Function)
      );
      expect(mockTransport.subscribe_queue).toHaveBeenNthCalledWith(
        2,
        'zone123',
        9000,
        expect.any(Function)
      );
    });

    it('M-4: caps requested max_item_count at MAX_QUEUE_SUBSCRIPTION_ITEMS', () => {
      // Defense-in-depth clamp: even if a validator bypassed by an
      // internal caller passes a huge number, the service must not
      // forward it to Roon. Routes/socket additionally reject > MAX
      // with a 400, but this test pins the service-internal cap.
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeQueue('zone123', 1_000_000_000);

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS,
        expect.any(Function)
      );
    });

    it('M-4: caps zone-derived size at MAX even when queue_items_remaining is huge', () => {
      // If a (malformed?) zone payload claims billions of remaining
      // queue items, we shouldn't pass that through. The clamp also
      // covers the basedOnZone path.
      mockTransport.subscribe_zones.mockImplementation((callback: Function) => {
        callback('Subscribed', {
          zones: [
            {
              zone_id: 'zone123',
              display_name: 'Main Zone',
              state: 'playing',
              queue_items_remaining: 999_999_999,
            },
          ],
        });
      });

      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeZones();
      service.subscribeQueue('zone123');

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS,
        expect.any(Function)
      );
    });
  });

  describe('queue positional diffs', () => {
    // Real Roon queue subscriptions deliver mutations as splice-style ops:
    //   { changes: [{ operation: "insert"|"remove", index, items?, count? }] }
    // (verified by capture against a live Core, May 2026). The fields
    // items_added/items_changed/items_removed shown in older docs are NOT
    // what the JS transport service actually delivers.

    function captureSnapshot(
      callback: { current: ((response: string, data: any) => void) | null }
    ) {
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, cb: any) => {
          callback.current = cb;
          cb('Subscribed', { items: [] });
          return { unsubscribe: jest.fn() };
        }
      );
    }

    it('applies "insert" at the given index', () => {
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 1, one_line: { line1: 'A' } },
              { queue_item_id: 2, one_line: { line1: 'B' } },
            ],
          },
        ],
      });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([1, 2]);
    });

    it('applies "remove" with count at the given index', () => {
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 1, one_line: { line1: 'A' } },
              { queue_item_id: 2, one_line: { line1: 'B' } },
              { queue_item_id: 3, one_line: { line1: 'C' } },
            ],
          },
        ],
      });
      cb.current('Changed', {
        changes: [{ operation: 'remove', index: 0, count: 2 }],
      });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([3]);
    });

    it('applies "remove" then "insert" in a single payload (track consumed → next becomes current)', () => {
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 100, one_line: { line1: 'Now Playing' } },
              { queue_item_id: 101, one_line: { line1: 'Next' } },
            ],
          },
        ],
      });
      // Track ends: Roon removes index 0, then inserts a new tail item.
      cb.current('Changed', {
        changes: [
          { operation: 'remove', index: 0, count: 1 },
          {
            operation: 'insert',
            index: 1,
            items: [{ queue_item_id: 102, one_line: { line1: 'Tail' } }],
          },
        ],
      });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([101, 102]);
    });

    it('preserves insertion order with non-monotonic queue_item_ids', () => {
      // After "Play Next" from another control point, IDs in the queue
      // can be out of numeric order — but Roon's positional inserts still
      // place them correctly. Confirms we do NOT re-sort by ID.
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 100, one_line: { line1: 'First' } },
              { queue_item_id: 102, one_line: { line1: 'Third' } },
            ],
          },
        ],
      });
      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 1,
            items: [{ queue_item_id: 42, one_line: { line1: 'Inserted next' } }],
          },
        ],
      });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([100, 42, 102]);
    });

    it('skips a known op with missing/invalid index instead of defaulting to 0', () => {
      // Defaulting bad index to 0 would silently mutate the current track.
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 1, one_line: { line1: 'Current' } },
              { queue_item_id: 2, one_line: { line1: 'Next' } },
            ],
          },
        ],
      });
      cb.current('Changed', {
        changes: [{ operation: 'remove', count: 1 /* index missing */ }],
      });

      // Current row must not have been removed.
      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([1, 2]);
    });

    it('skips a remove with missing/invalid count instead of defaulting to 1', () => {
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [
              { queue_item_id: 1, one_line: { line1: 'Current' } },
              { queue_item_id: 2, one_line: { line1: 'Next' } },
            ],
          },
        ],
      });
      cb.current('Changed', {
        changes: [{ operation: 'remove', index: 0 /* count missing */ }],
      });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([1, 2]);
    });

    it('ignores unknown operations without corrupting the queue', () => {
      const cb = { current: null as any };
      captureSnapshot(cb);
      service.subscribeQueue('zone1');

      cb.current('Changed', {
        changes: [
          {
            operation: 'insert',
            index: 0,
            items: [{ queue_item_id: 1, one_line: { line1: 'A' } }],
          },
        ],
      });
      cb.current('Changed', { changes: [{ operation: 'rotate-by-pi', index: 0 }] });

      expect(service.getQueue('zone1').items.map((i) => i.queue_item_id)).toEqual([1]);
    });
  });

  describe('queue ordering', () => {
    it('preserves Roon-supplied snapshot order, even when queue_item_id is non-monotonic', () => {
      // Simulates a queue where Roon delivers items in play order but the IDs
      // are not numerically increasing (e.g. after a "Play Next" insert).
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', {
            items: [
              { queue_item_id: 100, one_line: { line1: 'First' } },
              { queue_item_id: 42, one_line: { line1: 'Inserted' } },
              { queue_item_id: 101, one_line: { line1: 'Third' } },
            ],
          });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeQueue('zone123');
      const queue = service.getQueue('zone123');

      expect(queue.items.map((i) => i.queue_item_id)).toEqual([100, 42, 101]);
    });

    it('drops queue items missing a valid queue_item_id rather than collapsing them onto 0', () => {
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', {
            items: [
              { queue_item_id: 5, one_line: { line1: 'Valid' } },
              { one_line: { line1: 'Missing id' } },
              { queue_item_id: 'nope', one_line: { line1: 'Bad type' } },
            ],
          });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeQueue('zone123');
      const queue = service.getQueue('zone123');

      expect(queue.items).toHaveLength(1);
      expect(queue.items[0].queue_item_id).toBe(5);
    });
  });

  describe('playFromHere', () => {
    it('should call transport.play_from_here', async () => {
      mockTransport.play_from_here.mockImplementation(
        (_zoneId: string, _queueItemId: number, callback: Function) => {
          callback({ name: 'Success' });
        }
      );

      await service.playFromHere('zone123', 4);

      expect(mockTransport.play_from_here).toHaveBeenCalledWith(
        'zone123',
        4,
        expect.any(Function)
      );
    });
  });
});
