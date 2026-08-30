function generateFileId() {
    const now = new Date();

    const day = String(now.getDate());
    const month = String(now.getMonth() + 1);
    const year = now.getFullYear();
    const hours = String(now.getHours());
    const minutes = String(now.getMinutes());
    const seconds = String(now.getSeconds());

    const timestamp = `${day}${month}${year}${hours}${minutes}${seconds}`;
    const number = BigInt(timestamp);

    return number.toString(36).toUpperCase();
}

module.exports = { generateFileId };

if (require.main === module) {
    const id = generateFileId();
    const now = new Date();
    const day = String(now.getDate());
    const month = String(now.getMonth() + 1);
    const year = now.getFullYear();
    const hours = String(now.getHours());
    const minutes = String(now.getMinutes());
    const seconds = String(now.getSeconds());
    const timestamp = `${day}${month}${year}${hours}${minutes}${seconds}`;
    console.log("Timestamp:", timestamp);
    console.log("Number:", BigInt(timestamp).toString());
    console.log("Base-36:", id);
}
