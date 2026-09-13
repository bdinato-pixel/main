import type { CloseModule, DcaModule, GridConfig, Hook, OpenModule, SlModule, SlxModule, TpModule } from '../store/types.js';

export function defaultGridConfig(): GridConfig {
  return {
    count: 4,
    priceMode: 'offset',
    firstPrice: 0,
    lastPrice: 0,
    levels: [],
    firstOfsPct: 0.5,
    lastOfsPct: 3,
    qtyFactor: 1,
    density: 1,
  };
}

export function defaultOpenModule(): OpenModule {
  return {
    enabled: true,
    amount: { mode: 'volume_usd', value: 50 },
    orderType: 'market',
    entry: 'single',
    grid: defaultGridConfig(),
    priceOffsetPct: 0,
    leverage: 5,
    marginMode: 'cross',
    positionMode: 'both',
    timeoutMin: 0,
    maxOpenPositions: 0,
    maxTotalVolumeUsd: 0,
    maxHookPositions: 0,
    maxHookVolumeUsd: 0,
    blacklist: [],
    whitelist: [],
  };
}

export function defaultDcaModule(): DcaModule {
  return {
    enabled: false,
    amount: { mode: 'position_volume_pct', value: 100 },
    orderType: 'market',
    entry: 'single',
    grid: defaultGridConfig(),
    priceOffsetPct: 0,
    maxPositionVolumeUsd: 0,
    allowWithOpenDcaOrders: true,
  };
}

export function defaultCloseModule(): CloseModule {
  return {
    enabled: true,
    orderType: 'market',
    mode: 'full',
    amount: { mode: 'position_volume_pct', value: 100 },
    reverse: false,
    checkProfit: false,
    closeAll: 'off',
  };
}

export function defaultSlModule(): SlModule {
  return {
    enabled: false,
    ofsPct: 5,
    price: 0,
    orderType: 'stop_market',
    reorderAfterDca: true,
    trigger: 'price',
    candleTf: '1m',
  };
}

export function defaultSlxModule(): SlxModule {
  return {
    enabled: false,
    activationOfsPct: 1,
    trailPct: 0.5,
    breakevenAfterTp: 0,
    trigger: 'price',
    candleTf: '1m',
  };
}

export function defaultTpModule(): TpModule {
  return {
    enabled: false,
    orderType: 'limit',
    orders: [{ ofsPct: 1, price: 0, piecePct: 100 }],
    reorderLevels: true,
    updateBySignal: false,
  };
}

export function defaultHookModules(): Pick<Hook, 'open' | 'dca' | 'close' | 'sl' | 'slx' | 'tp'> {
  return {
    open: defaultOpenModule(),
    dca: defaultDcaModule(),
    close: defaultCloseModule(),
    sl: defaultSlModule(),
    slx: defaultSlxModule(),
    tp: defaultTpModule(),
  };
}
