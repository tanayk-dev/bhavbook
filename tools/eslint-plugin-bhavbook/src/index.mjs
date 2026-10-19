import noFloatMoney from './no-float-money.mjs';

const plugin = {
  meta: { name: 'eslint-plugin-bhavbook', version: '0.0.0' },
  rules: {
    'no-float-money': noFloatMoney,
  },
};

export default plugin;
