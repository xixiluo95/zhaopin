const { getCompanyEnrichmentStats } = require('./db');

function fetchCompanyEnrichmentStats() {
  return getCompanyEnrichmentStats();
}

module.exports = {
  fetchCompanyEnrichmentStats
};
