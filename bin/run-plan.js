require('dotenv').config();
const LocalFileStorageProvider = require('../lib/storage/LocalFileStorageProvider');
const { buildStores } = require('../lib/stores');
const createPlanModule = require('../lib/plan');

const stores = buildStores(new LocalFileStorageProvider());
createPlanModule(stores).runNightlyPlan();
