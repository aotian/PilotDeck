#include <iostream>
#include <vector>
using namespace std;
int main(){int n,m;cin>>n>>m;vector<string>a(n);for(auto&s:a)cin>>s;for(int r=0;r<n;r++){for(int c=0;c<m;c++){if(a[r][c]=='*'){cout<<'*';continue;}int cnt=0;for(int dr=-1;dr<=1;dr++)for(int dc=-1;dc<=1;dc++){int nr=r+dr,nc=c+dc;if(0<=nr&&nr<n&&0<=nc&&nc<m&&a[nr][nc]=='*')cnt++;}cout<<cnt;}cout<<'\n';}}
