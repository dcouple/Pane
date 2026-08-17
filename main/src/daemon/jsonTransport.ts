import {
  decodeBoundary,
  type BoundarySchema,
} from '../../../shared/validation/boundaryDecoder';

export function serializeJsonTransport<Value, Decoded>(
  value: Value,
  schema: BoundarySchema<Decoded>,
): Decoded {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('JSON transport value is not serializable');
  }

  return decodeBoundary(JSON.parse(serialized), schema);
}
