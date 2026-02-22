const fs = require('fs');
const Jimp = require('jimp');
const pngToIco = require('png-to-ico');

async function main() {
    try {
        console.log('Reading icon.jpg...');
        const img = await Jimp.read('build/icon.jpg');
        console.log('Resizing to 256x256...');
        img.resize(256, 256);
        console.log('Writing to icon.png...');
        await img.writeAsync('build/icon.png');
        console.log('Converting to ICO...');
        const buf = await pngToIco.default('build/icon.png');
        fs.writeFileSync('build/icon.ico', buf);
        console.log('Success! Icon converted correctly.');
    } catch (e) {
        console.error('Error during conversion:', e);
    }
}
main();
