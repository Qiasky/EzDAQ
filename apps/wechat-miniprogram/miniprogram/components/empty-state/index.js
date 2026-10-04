// components/empty-state/index.js
Component({
  properties: {
    title: { type: String, value: '暂无数据' },
    desc: { type: String, value: '' },
    icon: { type: String, value: 'empty' }, // empty / search / error
    actionText: { type: String, value: '' },
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});