const api = require('./api');
module.exports = { getList: api.devices, refreshList: api.devices, getDetail: api.detail };
