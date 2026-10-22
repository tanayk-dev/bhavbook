// Labels shared by the charts and their tables (kept apart from the charts, which load lazily with ECharts).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-09" as "Sep 2025". */
export const monthLabel = (month: string): string => {
  const [year = '', number = '1'] = month.split('-');
  return `${MONTHS[Number.parseInt(number, 10) - 1] ?? month} ${year}`;
};
