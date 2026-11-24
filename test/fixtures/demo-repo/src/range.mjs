// Return the whole numbers from start to end, including both ends.
export function range(start, end) {
  const values = [];
  for (let value = start; value < end; value += 1) values.push(value);
  return values;
}
