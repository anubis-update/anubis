function englishDiagnostic (value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/OSV API не проверил пакетов без поддержки или сверх лимита: (\d+)/g, 'OSV API: $1 unsupported or over-limit packages were not checked')
    .replace(/NVD API вернул HTTP (\d+)/g, 'NVD API returned HTTP $1')
    .replace(/CISA KEV вернул HTTP (\d+)/g, 'CISA KEV returned HTTP $1')
    .replace(/не сопоставлено с purl\/CPE: (\d+) из (\d+) программ \(см\. data\.unmapped\)/g, '$1 of $2 installed programs could not be mapped to purl/CPE (see data.unmapped)')
    .replace(/не проверено ни одной подходящей базой либо превышен лимит запросов: (\d+) программ/g, '$1 installed programs were not checked by a matching database or exceeded the query limit')
    .replace(/ОС не сопоставлена с CPE или не проверена NVD: /g, 'The operating system was not mapped to CPE or checked by NVD: ')
    .replace(/Не удалось загрузить CISA KEV: /g, 'Could not load CISA KEV: ')
    .replace(/Проверка завершена/g, 'Scan finished')
}

module.exports = { englishDiagnostic }
