#include <cmath>
#include <iostream>
using namespace std;

int main() {
    int n;
    if (!(cin >> n)) return 0;
    int r = static_cast<int>(sqrt(n));
    cout << (1LL * r * r == n ? "YES" : "NO") << '\n';
    cout << floor(3.8) << ' ' << ceil(3.2) << ' ' << round(3.5) << '\n';
    return 0;
}
