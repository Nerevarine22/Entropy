import { handleProductionMyStats } from '../my-stats.mjs';

export default { fetch: request => handleProductionMyStats(request, '/callback') };
