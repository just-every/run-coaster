/** Native expense cents use nearest-cent rounding, with exact halves away from zero.
 * Parse the provider's decimal representation so binary floating-point ties cannot change money.
 */
export function plaidMinor(value) {
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e9)return null;
  const [coefficient,exponent='0']=String(Math.abs(value)).toLowerCase().split('e');
  const fraction=coefficient.split('.')[1]?.length??0,scale=fraction-Number(exponent)-2;
  const digits=BigInt(coefficient.replace('.',''));
  const factor=10n**BigInt(Math.abs(scale));
  const magnitude=scale>0?(digits+factor/2n)/factor:digits*factor;
  const minor=Number(magnitude)*(value<0?-1:1);
  return Number.isSafeInteger(minor)&&Math.abs(minor)<=1e11?minor:null;
}
