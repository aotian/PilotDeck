#include <iostream>
#include <vector>
using namespace std;
int main(){int n;cin>>n;vector<vector<int>>a(n,vector<int>(n)),b(n,vector<int>(n));for(auto&r:a)for(int&x:r)cin>>x;for(int r=0;r<n;r++)for(int c=0;c<n;c++)b[c][n-1-r]=a[r][c];for(auto&r:b){for(int c=0;c<n;c++)cout<<r[c]<<(c+1==n?'\n':' ');}}
