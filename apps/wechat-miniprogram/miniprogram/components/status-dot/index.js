// components/status-dot/index.js
Component({
  properties: {
    // normal / warn / fault / offline / maintain
    status: {
      type: String,
      value: 'normal',
    },
    // dot 尺寸 rpx
    size: {
      type: Number,
      value: 16,
    },
    // 故障态是否呼吸闪烁
    pulse: {
      type: Boolean,
      value: false,
    },
  },
});