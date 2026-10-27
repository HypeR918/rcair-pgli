import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateAttachmentUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Некорректный URL вложения');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Для вложений разрешён только HTTPS на порту 443');
  }
  const hostname = url.hostname.toLowerCase();
  const address = hostname.replace(/^\[|\]$/g, '');
  if (isIP(address) && !isPublicAddress(address)) throw new Error('Запрещённый сетевой адрес вложения');
  const allowed = allowedHosts.some(rule => rule.startsWith('.')
    ? hostname.endsWith(rule) && hostname.length > rule.length
    : hostname === rule);
  if (!allowed) throw new Error(`Домен вложения ${hostname} не входит в разрешённый список`);
  return url;
}

// Проверка выполняется при установке соединения: адрес не резолвится повторно после проверки.
export function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
      return callback(new Error('Запрещённый сетевой адрес вложения'));
    }
    const family = typeof options === 'number' ? options : options.family;
    const selected = family ? addresses.filter(item => item.family === family) : addresses;
    if (!selected.length) return callback(new Error('Нет подходящего публичного адреса'));
    if (options.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  });
}
