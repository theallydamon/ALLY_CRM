import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # Navigate to page
        await page.goto("http://127.0.0.1:8000/index.html")
        await page.wait_for_selector("text=Overview")

        # Check date input count
        dates = await page.query_selector_all("input[type='date']")
        print(f"Total input[type='date'] on page: {len(dates)}")

        # Click on Home tab
        await page.click("button:has-text('Overview')") # Overview is Home
        await asyncio.sleep(1)

        # Take screenshot of home page layout
        await page.screenshot(path="screenshot_final.png", full_page=True)
        print("Saved screenshot_final.png")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
