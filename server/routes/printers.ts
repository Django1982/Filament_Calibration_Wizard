import { deleteHandler, getHandler, listHandler, putHandler } from './jsonResource.ts';

export const listPrinters = listHandler('printers');
export const getPrinter = getHandler('printers');
export const putPrinter = putHandler('printers');
export const deletePrinter = deleteHandler('printers');
